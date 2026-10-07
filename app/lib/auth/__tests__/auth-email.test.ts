import { describe, expect, it } from "vitest";
import {
  createAuthEmailHandlers,
  createTestEmailCapture,
} from "~/lib/auth/auth-email.server";

describe("auth email handlers", () => {
  const baseEnv = {
    AUTH_SECRET: "secret",
    APP_URL: "http://localhost:8888",
    AUTH_STORAGE: {
      async get() {
        return null;
      },
      async set() {},
      async delete() {},
    },
    EMAIL_ENABLED: "true",
    SMTP_HOST: "smtp.example.com",
    SMTP_FROM: "noreply@example.com",
  } as Env;

  it("captures verification and reset emails via test transport", async () => {
    const { env, sent } = createTestEmailCapture(baseEnv);
    const handlers = createAuthEmailHandlers(env);

    await handlers.sendVerificationEmail({
      user: { email: "user@example.com" },
      url: "http://localhost:8888/api/auth/verify-email?token=abc",
      token: "abc",
    });
    await handlers.sendResetPassword({
      user: { email: "user@example.com" },
      url: "http://localhost:8888/api/auth/reset-password/abc",
      token: "abc",
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]?.to).toBe("user@example.com");
    expect(sent[0]?.subject).toContain("Verify");
    expect(sent[0]?.text).toContain("verify-email?token=abc");
    expect(sent[1]?.subject).toContain("Reset");
    expect(sent[1]?.html).toContain("reset-password/abc");
  });

  it("escapes HTML in malicious verification links", async () => {
    const { env, sent } = createTestEmailCapture(baseEnv);
    const handlers = createAuthEmailHandlers(env);
    const malicious = 'http://evil.example/?a=1&b="><script>';

    await handlers.sendVerificationEmail({
      user: { email: "user@example.com" },
      url: malicious,
      token: "abc",
    });

    expect(sent[0]?.html).not.toContain("<script>");
    expect(sent[0]?.html).toContain("&quot;");
  });
});
