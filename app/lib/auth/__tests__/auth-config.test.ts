// Architectural guard for Better Auth config.
//
// These invariants were established empirically. Flipping any of them
// silently breaks production-critical
// behaviour (session loss / rate-limit no-op / device list empty), so we
// assert them at unit-test time. If a future Better Auth release legitimately
// changes the trade-off, update this test together with the config.

import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createAuth } from "~/lib/auth.server";

vi.mock("pg", () => ({
  default: {
    // db/client.server.ts calls pg.types.setTypeParser(20, …) at module load.
    types: { setTypeParser: () => {} },
    Pool: class MockPool {
      // Better Auth only calls .query()/.connect() at request time; the mock
      // doesn't need to be functional for config introspection.
      async connect() {
        return { release() {}, query: async () => ({ rows: [] }) };
      }
      async query() {
        return { rows: [] };
      }
      async end() {}
      on() {
        return this;
      }
    },
  },
}));

function buildEnv(): Env {
  return {
    DATABASE_URL: "postgres://stub:stub@stub:5432/stub",
    AUTH_STORAGE: {
      async get() {
        return null;
      },
      async set() {},
      async delete() {},
    },
    AUTH_SECRET:
      "0000000000000000000000000000000000000000000000000000000000000000",
    APP_URL: "http://localhost:8888",
    __authPoolOverride: new pg.Pool(),
  } as unknown as Env;
}

describe("auth.server config", () => {
  it("constructs without throwing", () => {
    const auth = createAuth(buildEnv());
    expect(auth).toBeDefined();
  });

  it("guards against Better Auth issue #4203 — cookieCache MUST be disabled", () => {
    const auth = createAuth(buildEnv());
    // Better Auth exposes the merged config on the instance.
    const cfg = (auth as unknown as { options: Record<string, unknown> })
      .options;
    const session = cfg.session as
      | { cookieCache?: { enabled?: boolean } }
      | undefined;
    expect(session?.cookieCache?.enabled).toBe(false);
  });

  it("stores sessions in DB so device-list / per-session revoke work", () => {
    const auth = createAuth(buildEnv());
    const cfg = (auth as unknown as { options: Record<string, unknown> })
      .options;
    const session = cfg.session as
      | { storeSessionInDatabase?: boolean }
      | undefined;
    expect(session?.storeSessionInDatabase).toBe(true);
  });

  it("trusts x-s2-client-ip so app-layer rate limit isn't a silent no-op", () => {
    const auth = createAuth(buildEnv());
    const cfg = (auth as unknown as { options: Record<string, unknown> })
      .options;
    const advanced = cfg.advanced as
      | { ipAddress?: { ipAddressHeaders?: string[] } }
      | undefined;
    expect(advanced?.ipAddress?.ipAddressHeaders).toContain("x-s2-client-ip");
  });

  // Keep prod rate limit on. The E2E suite minted a single
  // session in globalSetup precisely so we never have to relax this in
  // tests; if a future change disables the limiter (or shrinks the window
  // below 60s), credential-stuffing protection collapses
  // silently. Flip both this test and the config together if intentional.
  it("keeps Better Auth rate limit enabled with the expected window", () => {
    const auth = createAuth(buildEnv());
    const cfg = (auth as unknown as { options: Record<string, unknown> })
      .options;
    const rateLimit = cfg.rateLimit as
      | { enabled?: boolean; window?: number; max?: number }
      | undefined;
    expect(rateLimit?.enabled).toBe(true);
    expect(rateLimit?.window).toBeGreaterThanOrEqual(60);
    expect(rateLimit?.max).toBeGreaterThan(0);
  });

  // Passkey plugin invariants.
  it("registers the passkey plugin when PASSKEY_ENABLED is true", () => {
    const auth = createAuth(buildEnv());
    const cfg = (auth as unknown as { options: Record<string, unknown> })
      .options;
    const plugins = cfg.plugins as Array<{ id?: string }> | undefined;
    expect(plugins).toBeDefined();
    expect(plugins?.some((p) => p?.id === "passkey")).toBe(true);
  });

  it("omits the passkey plugin when PASSKEY_ENABLED is false", () => {
    const env = buildEnv();
    (env as Env & { PASSKEY_ENABLED: string }).PASSKEY_ENABLED = "false";
    const auth = createAuth(env);
    const cfg = (auth as unknown as { options: Record<string, unknown> })
      .options;
    const plugins = cfg.plugins as Array<{ id?: string }> | undefined;
    expect(plugins?.some((p) => p?.id === "passkey")).toBe(false);
  });

  // twoFactor plugin invariant.
  it("registers the twoFactor plugin when TOTP_ENABLED is true", () => {
    const auth = createAuth(buildEnv());
    const cfg = (auth as unknown as { options: Record<string, unknown> })
      .options;
    const plugins = cfg.plugins as Array<{ id?: string }> | undefined;
    expect(plugins).toBeDefined();
    expect(plugins?.some((p) => p?.id === "two-factor")).toBe(true);
  });

  it("omits the twoFactor plugin when TOTP_ENABLED is false", () => {
    const env = buildEnv();
    (env as Env & { TOTP_ENABLED: string }).TOTP_ENABLED = "false";
    const auth = createAuth(env);
    const cfg = (auth as unknown as { options: Record<string, unknown> })
      .options;
    const plugins = cfg.plugins as Array<{ id?: string }> | undefined;
    expect(plugins?.some((p) => p?.id === "two-factor")).toBe(false);
  });

  it("enables email verification and password reset when EMAIL_ENABLED is true", () => {
    const env = buildEnv();
    const authEnv = env as Env & {
      EMAIL_ENABLED: string;
      __emailTransportOverride: () => Promise<void>;
    };
    authEnv.EMAIL_ENABLED = "true";
    authEnv.__emailTransportOverride = async () => {};
    const auth = createAuth(authEnv);
    const cfg = (auth as unknown as { options: Record<string, unknown> })
      .options;
    const emailAndPassword = cfg.emailAndPassword as
      | {
          requireEmailVerification?: boolean;
          sendResetPassword?: unknown;
          autoSignIn?: boolean;
        }
      | undefined;
    const emailVerification = cfg.emailVerification as
      | { sendVerificationEmail?: unknown; sendOnSignIn?: boolean }
      | undefined;
    expect(emailAndPassword?.requireEmailVerification).toBe(true);
    expect(emailAndPassword?.sendResetPassword).toBeTypeOf("function");
    expect(emailAndPassword?.autoSignIn).toBe(false);
    expect(emailVerification?.sendVerificationEmail).toBeTypeOf("function");
    expect(emailVerification?.sendOnSignIn).toBe(true);
  });

  it("keeps email verification and password reset disabled when EMAIL_ENABLED is false", () => {
    const env = buildEnv();
    (env as Env & { EMAIL_ENABLED: string }).EMAIL_ENABLED = "false";
    const auth = createAuth(env);
    const cfg = (auth as unknown as { options: Record<string, unknown> })
      .options;
    const emailAndPassword = cfg.emailAndPassword as
      | {
          requireEmailVerification?: boolean;
          sendResetPassword?: unknown;
          autoSignIn?: boolean;
        }
      | undefined;
    expect(emailAndPassword?.requireEmailVerification).toBe(false);
    expect(emailAndPassword?.sendResetPassword).toBeUndefined();
    expect(emailAndPassword?.autoSignIn).toBe(true);
    expect(cfg.emailVerification).toBeUndefined();
  });

  // rateLimit writes on every Better Auth request,
  // which added 800–1900ms tail latency to hot read-only auth endpoints.
  // The fix excludes those paths via `customRules: { "/path": false }` and
  // tightens credential-guessing endpoints. These assertions guard against
  // path-name typos — a misspelled key silently falls back to the default
  // limit (60s/100) and the latency symptom returns.
  describe("rateLimit.customRules", () => {
    function getCustomRules(env = buildEnv()) {
      const auth = createAuth(env);
      const cfg = (auth as unknown as { options: Record<string, unknown> })
        .options;
      const rateLimit = cfg.rateLimit as
        | {
            customRules?: Record<
              string,
              false | { window: number; max: number }
            >;
          }
        | undefined;
      return rateLimit?.customRules;
    }

    it.each([
      "/get-session",
      "/list-sessions",
      "/list-accounts",
      "/passkey/list-user-passkeys",
    ])("excludes hot path %s from the rate limit", (path) => {
      expect(getCustomRules()?.[path]).toBe(false);
    });

    it("does not register passkey hot paths when PASSKEY_ENABLED is false", () => {
      const env = buildEnv();
      (env as Env & { PASSKEY_ENABLED: string }).PASSKEY_ENABLED = "false";
      expect(
        getCustomRules(env)?.["/passkey/list-user-passkeys"],
      ).toBeUndefined();
    });

    it.each([
      "/sign-in/email",
      "/sign-up/email",
      "/two-factor/verify-totp",
      "/two-factor/verify-backup-code",
    ])("keeps credential-guessing endpoint %s rate-limited with a tight rule", (path) => {
      const rule = getCustomRules()?.[path];
      // Shape only — leave the actual numbers free to tune without
      // chasing this test.
      expect(rule).toEqual(
        expect.objectContaining({
          window: expect.any(Number),
          max: expect.any(Number),
        }),
      );
    });

    it("does not register TOTP verify paths when TOTP_ENABLED is false", () => {
      const env = buildEnv();
      (env as Env & { TOTP_ENABLED: string }).TOTP_ENABLED = "false";
      const rules = getCustomRules(env);
      expect(rules?.["/two-factor/verify-totp"]).toBeUndefined();
      expect(rules?.["/two-factor/verify-backup-code"]).toBeUndefined();
    });

    it("rate-limits email endpoints when EMAIL_ENABLED is true", () => {
      const env = buildEnv();
      const authEnv = env as Env & {
        EMAIL_ENABLED: string;
        __emailTransportOverride: () => Promise<void>;
      };
      authEnv.EMAIL_ENABLED = "true";
      authEnv.__emailTransportOverride = async () => {};
      const rules = getCustomRules(authEnv);
      expect(rules?.["/request-password-reset"]).toEqual(
        expect.objectContaining({
          window: expect.any(Number),
          max: expect.any(Number),
        }),
      );
      expect(rules?.["/send-verification-email"]).toEqual(
        expect.objectContaining({
          window: expect.any(Number),
          max: expect.any(Number),
        }),
      );
    });

    it("does not register email rate-limit paths when EMAIL_ENABLED is false", () => {
      const env = buildEnv();
      (env as Env & { EMAIL_ENABLED: string }).EMAIL_ENABLED = "false";
      const rules = getCustomRules(env);
      expect(rules?.["/request-password-reset"]).toBeUndefined();
      expect(rules?.["/send-verification-email"]).toBeUndefined();
    });
  });

  it("derives passkey rpID/origin from APP_URL (env auto-switch)", () => {
    const env = buildEnv();
    // Override APP_URL to verify dynamic derivation rather than hard-coded host.
    (env as Env & { APP_URL: string }).APP_URL = "https://s2.example.com";
    const auth = createAuth(env);
    const cfg = (auth as unknown as { options: Record<string, unknown> })
      .options;
    const plugins = cfg.plugins as
      | Array<{ id?: string; options?: Record<string, unknown> }>
      | undefined;
    const pk = plugins?.find((p) => p?.id === "passkey");
    expect(pk?.options?.rpID).toBe("s2.example.com");
    expect(pk?.options?.origin).toBe("https://s2.example.com");
  });
});
