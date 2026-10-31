import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import LoginPage from "../login";
import LoginTwoFactorPage from "../login.two-factor";

const signInEmailMock = vi.fn();
const signInPasskeyMock = vi.fn();
const verifyTotpMock = vi.fn();

vi.mock("~/lib/auth/auth.server", () => ({ getUser: vi.fn() }));

vi.mock("~/lib/auth.client", () => ({
  authClient: {
    signIn: {
      email: (...args: unknown[]) => signInEmailMock(...args),
      passkey: (...args: unknown[]) => signInPasskeyMock(...args),
    },
    twoFactor: {
      verifyTotp: (...args: unknown[]) => verifyTotpMock(...args),
      verifyBackupCode: vi.fn(),
    },
  },
}));

const longAuthorize = `/oauth/authorize?${new URLSearchParams({
  response_type: "code",
  client_id: "client",
  redirect_uri: "https://client.example/callback",
  scope: "files:read",
  state: "s".repeat(3000),
})}`;

const accepted: Array<[string, string | null, string]> = [
  ["a missing returnTo", null, "/"],
  ["a long OAuth authorize URL", longAuthorize, longAuthorize],
  ["a backslash in the query", "/files?q=a\\b", "/files?q=a\\b"],
  ["a plain path", "/files", "/files"],
];

const rejected: Array<[string, string]> = [
  ["javascript:", "javascript:alert(document.domain)"],
  ["an other-origin absolute URL", "https://evil.example/"],
  ["a protocol-relative URL", "//evil.example/"],
  ["a backslash-prefixed host", "/\\evil.example"],
  ["a tab-smuggled host", "/\t/evil.example"],
];

const cases: Array<[string, string | null, string]> = [
  ...accepted,
  ...rejected.map(([name, value]): [string, string | null, string] => [
    name,
    value,
    "/",
  ]),
];

function visit(pathname: string, returnTo: string | null) {
  const search =
    returnTo === null ? "" : `?${new URLSearchParams({ returnTo })}`;
  window.history.replaceState(null, "", `${pathname}${search}`);
}

function renderLogin() {
  render(
    <MemoryRouter>
      <LoginPage
        {...({
          loaderData: {
            signupEnabled: false,
            passkeyEnabled: true,
            emailEnabled: false,
          },
        } as unknown as Parameters<typeof LoginPage>[0])}
      />
    </MemoryRouter>,
  );
}

let assignSpy: MockInstance<(url: string | URL) => void>;
const originalPath = `${window.location.pathname}${window.location.search}`;

beforeEach(() => {
  signInEmailMock.mockReset();
  signInPasskeyMock.mockReset();
  verifyTotpMock.mockReset();
  assignSpy = vi
    .spyOn(window.location, "assign")
    .mockImplementation(() => undefined);
  Object.defineProperty(window, "PublicKeyCredential", {
    configurable: true,
    writable: true,
    value: function PublicKeyCredential() {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "PublicKeyCredential");
  window.history.replaceState(null, "", originalPath);
});

describe("login returnTo navigation", () => {
  it.each(cases)("passkey sign-in with %s", async (_, returnTo, expected) => {
    signInPasskeyMock.mockResolvedValue({ data: {}, error: null });
    visit("/login", returnTo);
    renderLogin();

    await userEvent.click(
      screen.getByRole("button", { name: /sign in with a passkey/i }),
    );

    await waitFor(() => expect(assignSpy).toHaveBeenCalledTimes(1));
    expect(assignSpy).toHaveBeenCalledWith(expected);
  });

  it.each(cases)("password sign-in with %s", async (_, returnTo, expected) => {
    signInEmailMock.mockResolvedValue({ data: {}, error: null });
    visit("/login", returnTo);
    renderLogin();

    await userEvent.type(screen.getByLabelText(/email/i), "a@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "pw");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(assignSpy).toHaveBeenCalledTimes(1));
    expect(assignSpy).toHaveBeenCalledWith(expected);
    expect(signInEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ callbackURL: expected }),
    );
  });

  it.each(cases)("two-factor verify with %s", async (_, returnTo, expected) => {
    verifyTotpMock.mockResolvedValue({ data: {}, error: null });
    visit("/login/two-factor", returnTo);
    render(
      <MemoryRouter>
        <LoginTwoFactorPage />
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByRole("textbox"), "123456");
    await userEvent.click(screen.getByRole("button", { name: /verify/i }));

    await waitFor(() => expect(assignSpy).toHaveBeenCalledTimes(1));
    expect(assignSpy).toHaveBeenCalledWith(expected);
  });
});
