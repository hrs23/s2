// Wrapper auth instance ONLY for `@better-auth/cli generate`.
//
// The CLI does a static introspection of the auth config — it cannot import
// the runtime per-request factory in `app/lib/auth.server.ts`. This file
// only carries the *schema-affecting* options the CLI actually inspects:
//
//   - `database` (any node-postgres-compatible Pool)
//   - `emailAndPassword.enabled` — gates the `account.password` column
//   - `user.additionalFields` — emits the `last_sign_in_at` column
//   - `session.storeSessionInDatabase` — gates the `session` table
//   - `plugins: [passkey]` — the passkey plugin emits the `passkey` table
//
// Runtime-only options that do NOT affect the schema (secondary storage,
// `cookieCache`, `advanced.ipAddress`, `rateLimit`, `databaseHooks`, etc.)
// are intentionally OMITTED.
// `pnpm check:auth-schema` runs `better-auth generate` and diffs against
// schema.sql to catch drift; runtime-only changes never trip it.

import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins/two-factor";
import pg from "pg";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/s2",
  max: 1,
});

export const auth = betterAuth({
  database: pool,
  emailAndPassword: { enabled: true, autoSignIn: true },
  user: {
    // Split pattern: only auth-adjacent state lives on the Better
    // Auth `user` row. Business state (limits / quota) is owned by
    // s2 in user_limits / user_storage side tables.
    additionalFields: {
      last_sign_in_at: {
        type: "date",
        required: false,
        // Not exposed via the auth API surface — written by the
        // `databaseHooks.session.create.after` hook only.
        input: false,
      },
    },
  },
  // Stub rpID/origin: schema is host-agnostic, the CLI only inspects which
  // tables/columns the plugin contributes. Runtime values come from APP_URL.
  plugins: [
    passkey({ rpID: "stub", rpName: "S2", origin: "https://stub" }),
    // Emits the `twoFactor` table + `user.twoFactorEnabled`.
    twoFactor(),
  ],
  session: {
    storeSessionInDatabase: true,
  },
});
