import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestEmailCapture } from "~/lib/auth/auth-email.server";
import {
  cleanTestEnv,
  createTestEnv,
  disposeTestEnv,
  type TestEnv,
  testLoadContext,
} from "~/test/integration-helpers";
import { action } from "../api.auth.$";

let testEnv: TestEnv;
let sentEmails: ReturnType<typeof createTestEmailCapture>["sent"];

function ctx() {
  return testLoadContext(testEnv);
}

beforeAll(async () => {
  testEnv = await createTestEnv();
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
  const capture = createTestEmailCapture(testEnv.env);
  sentEmails = capture.sent;
  testEnv.env = capture.env;
});

let ipSeq = 0;

function nextIp() {
  ipSeq += 1;
  return `203.0.113.${ipSeq}`;
}

async function signUp(email = "new-user@example.com") {
  return action({
    request: new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-s2-client-ip": nextIp(),
      },
      body: JSON.stringify({
        email,
        password: "correcthorsebatterystaple",
        name: "",
        callbackURL: "/login?verified=1",
      }),
    }),
    context: ctx(),
    params: {},
  } as Parameters<typeof action>[0]);
}

async function signIn(email = "new-user@example.com") {
  return action({
    request: new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-s2-client-ip": nextIp(),
      },
      body: JSON.stringify({ email, password: "correcthorsebatterystaple" }),
    }),
    context: ctx(),
    params: {},
  } as Parameters<typeof action>[0]);
}

describe("email auth when EMAIL_ENABLED=true", () => {
  it("sends a verification email on sign-up and blocks sign-in until verified", async () => {
    const res = await signUp();
    expect(res.status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.subject).toContain("Verify");

    const user = await testEnv.db.queryOne<{ emailVerified: boolean }>(
      `SELECT "emailVerified" FROM "user" WHERE email = $1`,
      ["new-user@example.com"],
    );
    expect(user?.emailVerified).toBe(false);

    const signInRes = await signIn();
    expect(signInRes.status).toBe(403);
    const body = (await signInRes.json()) as { code?: string };
    expect(body.code).toBe("EMAIL_NOT_VERIFIED");
    expect(sentEmails).toHaveLength(2);
  });

  it("sends a password reset email and allows resetting the password", async () => {
    await signUp();
    sentEmails.length = 0;

    const requestRes = await action({
      request: new Request("http://localhost/api/auth/request-password-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-s2-client-ip": nextIp(),
        },
        body: JSON.stringify({
          email: "new-user@example.com",
          redirectTo: "http://localhost/reset-password",
        }),
      }),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect(requestRes.status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.subject).toContain("Reset");

    const resetUrl = sentEmails[0]?.text.match(/http[^\s]+/)?.[0];
    expect(resetUrl).toBeTruthy();
    const token = resetUrl?.match(/reset-password\/([^/?]+)/)?.[1];
    expect(token).toBeTruthy();

    const resetRes = await action({
      request: new Request("http://localhost/api/auth/reset-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-s2-client-ip": nextIp(),
        },
        body: JSON.stringify({
          newPassword: "brandnewpassword123",
          token,
        }),
      }),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect(resetRes.status).toBe(200);

    const oldSignIn = await signIn();
    expect(oldSignIn.status).toBe(401);

    const newSignIn = await action({
      request: new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-s2-client-ip": nextIp(),
        },
        body: JSON.stringify({
          email: "new-user@example.com",
          password: "brandnewpassword123",
        }),
      }),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect(newSignIn.status).toBe(403);
  });
});

describe("/api/auth/email flows when EMAIL_ENABLED=false", () => {
  beforeEach(() => {
    delete (testEnv.env as { EMAIL_ENABLED?: string }).EMAIL_ENABLED;
    delete (testEnv.env as { __emailTransportOverride?: unknown })
      .__emailTransportOverride;
  });

  it("signs up without verification email and allows immediate sign-in", async () => {
    const res = await signUp("immediate@example.com");
    expect(res.status).toBe(200);
    expect(sentEmails).toHaveLength(0);

    const signInRes = await signIn("immediate@example.com");
    expect(signInRes.status).toBe(200);
  });

  it("rejects password reset requests", async () => {
    const res = await action({
      request: new Request("http://localhost/api/auth/request-password-reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-s2-client-ip": nextIp(),
        },
        body: JSON.stringify({
          email: "missing@example.com",
          redirectTo: "http://localhost/reset-password",
        }),
      }),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("RESET_PASSWORD_DISABLED");
  });
});
