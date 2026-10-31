// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "~/lib/auth.server";
import { action, loader } from "../logout";

vi.mock("~/lib/auth.server", () => ({ createAuth: vi.fn() }));

const APP_URL = "http://localhost:8888";
const CLEAR_COOKIE = "better-auth.session_token=; Max-Age=0; Path=/";

const signOut = vi.fn();
const mockedCreateAuth = vi.mocked(createAuth);

function context() {
  return { runtime: { env: { APP_URL } as Env } };
}

function postRequest(headers: Record<string, string>): Request {
  return new Request(`${APP_URL}/logout`, { method: "POST", headers });
}

beforeEach(() => {
  signOut.mockReset();
  mockedCreateAuth.mockReset();
  signOut.mockImplementation(async () => {
    const headers = new Headers();
    headers.append("Set-Cookie", CLEAR_COOKIE);
    return { headers };
  });
  mockedCreateAuth.mockReturnValue({ api: { signOut } } as never);
});

describe("/logout", () => {
  it("does not sign out on GET", async () => {
    const res = await loader();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(mockedCreateAuth).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin POST without a cookie", async () => {
    const res = await action({
      request: postRequest({ Origin: "https://evil.example" }),
      context: context(),
      params: {},
    } as never);

    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin POST with a cookie", async () => {
    const res = await action({
      request: postRequest({
        Origin: "https://evil.example",
        Cookie: "better-auth.session_token=abc",
      }),
      context: context(),
      params: {},
    } as never);

    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("rejects a POST without an Origin header", async () => {
    const res = await action({
      request: postRequest({}),
      context: context(),
      params: {},
    } as never);

    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("signs out on a same-origin POST", async () => {
    const request = postRequest({
      Origin: APP_URL,
      Cookie: "better-auth.session_token=abc",
    });
    const res = await action({
      request,
      context: context(),
      params: {},
    } as never);

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({
      headers: request.headers,
      returnHeaders: true,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
    expect(res.headers.getSetCookie()).toEqual([CLEAR_COOKIE]);
  });
});
