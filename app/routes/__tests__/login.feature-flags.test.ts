import { describe, expect, it, vi } from "vitest";
import { getUser } from "~/lib/auth/auth.server";
import { loader as forgotPasswordLoader } from "../forgot-password";
import { loader as loginLoader } from "../login";
import { loader as twoFactorLoader } from "../login.two-factor";
import { loader as resetPasswordLoader } from "../reset-password";

vi.mock("~/lib/auth/auth.server", () => ({ getUser: vi.fn() }));

const mockedGetUser = vi.mocked(getUser);

function env(overrides: Partial<Env> = {}): Env {
  return {
    AUTH_SECRET: "secret",
    APP_URL: "http://localhost:8888",
    AUTH_STORAGE: {
      async get() {
        return null;
      },
      async set() {},
      async delete() {},
    },
    ...overrides,
  } as Env;
}

function loaderData<T>(result: unknown): T {
  expect(result).toEqual(expect.objectContaining({ data: expect.any(Object) }));
  return (result as { data: T }).data;
}

describe("auth feature flags in login routes", () => {
  it("exposes passkeyEnabled from PASSKEY_ENABLED in the login loader", async () => {
    mockedGetUser.mockResolvedValue(null);
    const enabled = await loginLoader({
      request: new Request("http://localhost/login"),
      context: { runtime: { env: env({ PASSKEY_ENABLED: "true" }) } },
      params: {},
    } as never);
    const disabled = await loginLoader({
      request: new Request("http://localhost/login"),
      context: { runtime: { env: env({ PASSKEY_ENABLED: "false" }) } },
      params: {},
    } as never);

    expect(
      loaderData<{ passkeyEnabled: boolean }>(enabled).passkeyEnabled,
    ).toBe(true);
    expect(
      loaderData<{ passkeyEnabled: boolean }>(disabled).passkeyEnabled,
    ).toBe(false);
  });

  it("redirects /login/two-factor when TOTP is disabled", async () => {
    const res = await twoFactorLoader({
      request: new Request("http://localhost/login/two-factor"),
      context: { runtime: { env: env({ TOTP_ENABLED: "false" }) } },
      params: {},
    } as never);

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("Location")).toBe("/login");
  });

  it("exposes emailEnabled from EMAIL_ENABLED in the login loader", async () => {
    mockedGetUser.mockResolvedValue(null);
    const enabled = await loginLoader({
      request: new Request("http://localhost/login"),
      context: { runtime: { env: env({ EMAIL_ENABLED: "true" }) } },
      params: {},
    } as never);
    const disabled = await loginLoader({
      request: new Request("http://localhost/login"),
      context: { runtime: { env: env({ EMAIL_ENABLED: "false" }) } },
      params: {},
    } as never);

    expect(loaderData<{ emailEnabled: boolean }>(enabled).emailEnabled).toBe(
      true,
    );
    expect(loaderData<{ emailEnabled: boolean }>(disabled).emailEnabled).toBe(
      false,
    );
  });

  it("redirects email routes when EMAIL_ENABLED is false", async () => {
    const forgot = await forgotPasswordLoader({
      request: new Request("http://localhost/forgot-password"),
      context: { runtime: { env: env({ EMAIL_ENABLED: "false" }) } },
      params: {},
    } as never);
    const reset = await resetPasswordLoader({
      request: new Request("http://localhost/reset-password"),
      context: { runtime: { env: env({ EMAIL_ENABLED: "false" }) } },
      params: {},
    } as never);

    expect((forgot as Response).status).toBe(302);
    expect((forgot as Response).headers.get("Location")).toBe("/login");
    expect((reset as Response).status).toBe(302);
    expect((reset as Response).headers.get("Location")).toBe("/login");
  });
});
