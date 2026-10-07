// Better Auth factory — one instance per runtime env, cached in a WeakMap.
//
// baseURL and trustedOrigins derive only from env.APP_URL, never from the
// request Host header. The Postgres pool is required via env.__authPoolOverride
// (self-host runtime and tests inject it).
//
// Locked-in invariants:
//   - `session.cookieCache.enabled = false`         — Better Auth issue #4203
//   - `session.storeSessionInDatabase = true`       — DB is source of truth, secondary storage is cache
//   - `advanced.ipAddress.ipAddressHeaders`         — x-s2-client-ip
//   - `__authPoolOverride`                          — required long-lived pool
//
// The architectural test in `app/lib/auth/__tests__/auth-config.test.ts`
// asserts these invariants — break it intentionally if you mean to change them.

import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins/two-factor";
import type pg from "pg";
import { createAuthEmailHandlers } from "~/lib/auth/auth-email.server";
import {
  isEmailEnabled,
  isPasskeyEnabled,
  isSignupEnabled,
  isTotpEnabled,
} from "~/lib/auth/auth-feature-policy";
import { logInfo } from "~/lib/observability/logger.server";
import { newId } from "~/lib/utils/ulid.server";

// Better Auth's default session cookie name. Single source of truth so the
// edge middleware and any future cookie-aware code agree.
// Better Auth ships this name out
// of the box and we don't override it.
export const BETTER_AUTH_SESSION_COOKIE = "better-auth.session_token";

const instances = new WeakMap<Env, ReturnType<typeof buildAuth>>();

export function createAuth(env: Env) {
  let auth = instances.get(env);
  if (!auth) {
    auth = buildAuth(env);
    instances.set(env, auth);
  }
  return auth;
}

function buildAuth(env: Env) {
  const pool = (env as Env & { __authPoolOverride?: pg.Pool })
    .__authPoolOverride;
  if (!pool) {
    throw new Error("__authPoolOverride missing — Better Auth requires a pool");
  }

  if (!env.AUTH_STORAGE) {
    throw new Error(
      "AUTH_STORAGE missing — required for Better Auth secondaryStorage",
    );
  }

  const appUrl = new URL(env.APP_URL);
  const baseURL = appUrl.origin;
  const trustedOrigins = [baseURL];
  const passkeyRpID = appUrl.hostname;
  const passkeyOrigin = appUrl.origin;

  const plugins = [];
  if (isPasskeyEnabled(env)) {
    plugins.push(
      // WebAuthn passkey support. AAL2 phishing-resistant.
      // Plugin lives in its own npm package (`@better-auth/passkey`), unlike
      // most Better Auth plugins which ship under `better-auth/plugins/*`.
      passkey({
        rpID: passkeyRpID,
        rpName: "S2",
        origin: passkeyOrigin,
      }),
    );
  }
  if (isTotpEnabled(env)) {
    plugins.push(
      // TOTP + recovery codes. With TOTP enabled the
      // password sign-in returns `{ twoFactorRedirect: true }` and sets a
      // short-lived `better-auth.two_factor` cookie; no session is issued
      // until /two-factor/verify-totp (or /two-factor/verify-backup-code)
      // succeeds. So `getSession()` is the natural gate — we don't invent an
      // intermediate "AAL1 session" state. Recovery codes default to 10 codes
      // of 10 chars formatted XXXXX-XXXXX, encrypted with AUTH_SECRET, and
      // are one-shot consume on verify (built-in). Better Auth's per-IP
      // /two-factor/* rate limit (3/10s, plus our app-wide 60s/100) provides
      // abuse throttling only; per-account NIST §5.2.2 counting is not implemented.
      twoFactor(),
    );
  }

  const customRules: Record<string, false | { window: number; max: number }> = {
    // Read-only session/account state lookup.
    "/get-session": false,
    "/list-sessions": false,
    "/list-accounts": false,
    // Credential-guessing surface — keep tight (5 attempts / 10s).
    "/sign-in/email": { window: 10, max: 5 },
    "/sign-up/email": { window: 10, max: 5 },
  };
  if (isPasskeyEnabled(env)) {
    customRules["/passkey/list-user-passkeys"] = false;
  }
  if (isTotpEnabled(env)) {
    // Individual /two-factor/* endpoints (NOT a wildcard — would
    // accidentally cover enable/disable flows which are sensitive in a
    // different way and are protected by `freshAge` instead).
    customRules["/two-factor/verify-totp"] = { window: 10, max: 5 };
    customRules["/two-factor/verify-backup-code"] = { window: 10, max: 5 };
  }
  if (isEmailEnabled(env)) {
    customRules["/request-password-reset"] = { window: 10, max: 5 };
    customRules["/send-verification-email"] = { window: 10, max: 5 };
  }

  const emailEnabled = isEmailEnabled(env);
  const emailHandlers = emailEnabled ? createAuthEmailHandlers(env) : null;

  return betterAuth({
    baseURL,
    basePath: "/api/auth",
    secret: env.AUTH_SECRET,
    database: pool,
    secondaryStorage: env.AUTH_STORAGE,
    trustedOrigins,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: emailEnabled,
      autoSignIn: !emailEnabled,
      ...(emailHandlers
        ? {
            sendResetPassword: emailHandlers.sendResetPassword,
            revokeSessionsOnPasswordReset: true,
          }
        : {}),
    },
    ...(emailHandlers
      ? {
          emailVerification: {
            sendOnSignIn: true,
            sendVerificationEmail: emailHandlers.sendVerificationEmail,
          },
        }
      : {}),
    user: {
      // Auth-adjacent state lives on the Better Auth `user` row. Resource
      // policy and usage live in user_limits / user_storage.
      additionalFields: {
        last_sign_in_at: {
          type: "date",
          required: false,
          // Not exposed via Better Auth's user-update API — written by the
          // session-create hook below.
          input: false,
        },
      },
    },
    plugins,
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            // Kill switch. Reject sign-ups when
            // `SIGNUP_ENABLED=false`.
            if (!isSignupEnabled(env)) {
              throw new Error("signup_disabled");
            }
          },
          after: async (user) => {
            // Split-pattern atomic seed. Better Auth runs the
            // hook inside the same flow as user creation, so a thrown error
            // here will surface as a sign-up failure (caller retries).
            //
            // We open a short-lived client out of the same pool. Better Auth
            // does not pass its `tx` to user.create.after, so this is a
            // separate statement — acceptable because user_limits /
            // user_storage rows are PK-FK to user(id) and idempotent.
            //
            // Single user-scoped transaction: every INSERT below targets an
            // RLS-protected table (user_limits / user_storage / grants
            // / user_grants / grant_paths). app.user_id is set so the
            // policies allow inserts for this user only.
            const client = await pool.connect();
            try {
              await client.query("BEGIN");
              await client.query("SELECT set_config('app.user_id', $1, true)", [
                user.id,
              ]);

              await client.query(
                "INSERT INTO user_limits (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
                [user.id],
              );
              await client.query(
                "INSERT INTO user_storage (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
                [user.id],
              );
              // Every user gets a "Default" API token at signup. Idempotent:
              // ON CONFLICT DO NOTHING keeps a hook retry safe.
              const defaultGrantId = newId("tok_");
              const createdAt = new Date().toISOString();
              await client.query(
                `INSERT INTO grants (id, user_id, base_path, created_at)
                 VALUES ($1, $2, '/', $3)
                 ON CONFLICT (id) DO NOTHING`,
                [defaultGrantId, user.id, createdAt],
              );
              await client.query(
                `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
                 VALUES ($1, $2, 'Default', true, NULL)
                 ON CONFLICT (grant_id) DO NOTHING`,
                [defaultGrantId, user.id],
              );
              await client.query(
                `INSERT INTO grant_paths (grant_id, path, access)
                 VALUES ($1, '', 'write')
                 ON CONFLICT DO NOTHING`,
                [defaultGrantId],
              );
              await client.query("COMMIT");
            } catch (err) {
              await client.query("ROLLBACK").catch(() => {});
              throw err;
            } finally {
              client.release();
            }

            // Emit a stable signup event without the user's email.
            logInfo("auth", "signup", { userId: user.id });
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            // Track per-user last sign-in.
            const client = await pool.connect();
            try {
              await client.query(
                'UPDATE "user" SET last_sign_in_at = now() WHERE id = $1',
                [session.userId],
              );
            } finally {
              client.release();
            }
          },
        },
      },
    },
    session: {
      // CRITICAL: cookieCache MUST stay disabled.
      // With cookieCache + secondaryStorage, sessions silently expire
      // client-side at 5 min and force re-login. Architectural test guards
      // this — do not flip without removing the guard intentionally.
      cookieCache: {
        enabled: false,
      },
      expiresIn: 60 * 60 * 24 * 7, // 7d
      updateAge: 60 * 60 * 24, // refresh every 1d
      // REQUIRED when secondaryStorage is configured AND we need device list
      // / per-session revoke. Without this flag,
      // Better Auth stores sessions in secondary storage only — the `session` DB table
      // stays empty, breaking device-list and individual revoke. Verified
      // empirically.
      storeSessionInDatabase: true,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      // secondaryStorage writes on every Better Auth request
      // (the limiter increments a counter per (IP, path)). On hot read-only
      // paths that adds 800–1900ms tail latency per auth call. Exclude them.
      // Credential-guessing endpoints stay tight and keep the per-IP counter.
      customRules,
    },
    advanced: {
      // Without this Better Auth cannot detect the client IP and silently
      // disables app-layer rate limit.
      ipAddress: {
        ipAddressHeaders: ["x-s2-client-ip"],
      },
    },
  });
}
