import type { FormEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { data, Link, redirect } from "react-router";
import { LandingFooter, LandingHeader } from "~/components/landing-content";
import { pageTitle } from "~/i18n/meta";
import { getRuntimeEnv } from "~/lib/app-load-context.server";
import { getUser } from "~/lib/auth/auth.server";
import {
  isEmailEnabled,
  isPasskeyEnabled,
  isSignupEnabled,
} from "~/lib/auth/auth-feature-policy";
import {
  readReturnToCookie,
  setReturnToCookie,
  validateReturnTo,
} from "~/lib/auth/return-to";
import { authClient } from "~/lib/auth.client";
import type { Route } from "./+types/login";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getRuntimeEnv(context);
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("Cookie") ?? "";
  const requested = validateReturnTo(url.searchParams.get("returnTo"));
  // Keep returnTo across the password and two-factor flow.
  const existing = readReturnToCookie(cookieHeader);

  const user = await getUser(request, env);
  if (user) {
    return redirect(requested ?? existing ?? "/");
  }

  const init: ResponseInit =
    requested && requested !== existing
      ? { headers: { "Set-Cookie": setReturnToCookie(requested) } }
      : {};
  return data(
    {
      signupEnabled: isSignupEnabled(env),
      passkeyEnabled: isPasskeyEnabled(env),
      emailEnabled: isEmailEnabled(env),
    },
    init,
  );
}

export function meta() {
  return [{ title: pageTitle("login") }];
}

export default function LoginPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("login");
  const params = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : "",
  );
  const initialError = params.get("error");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const handlePasswordSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const target =
        new URLSearchParams(window.location.search).get("returnTo") ?? "/";
      const { data, error } = await authClient.signIn.email({
        email,
        password,
        callbackURL: target,
      });
      if (error) {
        setError(error.code ?? error.message ?? "invalid_credentials");
        return;
      }
      // When 2FA is enabled, Better Auth returns `twoFactorRedirect: true`
      // and its `onTwoFactorRedirect` hook navigates to /login/two-factor.
      // Skip our own redirect so we don't race past the TOTP prompt.
      if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
        return;
      }
      // Full reload so loaders re-run with the new session cookie.
      window.location.assign(target);
    } finally {
      setSubmitting(false);
    }
  };

  // Passkey sign-in. Driven by authClient.signIn.passkey()
  // which kicks off navigator.credentials.get() and posts the assertion to
  // /api/auth/sign-in/passkey. The button is shown unconditionally; if the
  // user has no registered passkey for this rpID, the browser surfaces the
  // failure (we don't run a pre-check that would leak account existence).
  const handlePasskey = async () => {
    if (typeof window === "undefined" || !window.PublicKeyCredential) {
      setError("passkey_unsupported");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const target =
        new URLSearchParams(window.location.search).get("returnTo") ?? "/";
      // signIn.passkey() returns { error } on failure; on success the session
      // cookie is set and we trigger a full reload to /target so loaders re-run.
      const result = await authClient.signIn.passkey();
      if (result?.error) {
        setError("passkey_failed");
        setSubmitting(false);
        return;
      }
      window.location.assign(target);
    } catch {
      setError("passkey_failed");
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <LandingHeader />

      <div className="flex-1 flex items-center justify-center px-6">
        <div className="w-full max-w-sm text-center">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 mb-8">
            {t("heading")}
          </h1>

          {error && (
            <div className="mb-6 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {t(`errors.${error}`, {
                defaultValue: t("error", { error }),
              })}
            </div>
          )}

          <form onSubmit={handlePasswordSubmit} className="space-y-3 text-left">
            <div>
              <label
                htmlFor="email"
                className="block text-xs font-medium text-gray-700 mb-1"
              >
                {t("email.label")}
              </label>
              <input
                id="email"
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("email.placeholder")}
                className="w-full border border-gray-300 rounded-md px-4 py-3 focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="block text-xs font-medium text-gray-700 mb-1"
              >
                {t("password.label")}
              </label>
              <input
                id="password"
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-4 py-3 focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>
            {loaderData.emailEnabled && (
              <div className="flex justify-end">
                <Link
                  to="/forgot-password"
                  className="text-xs text-gray-500 hover:text-gray-700 underline"
                >
                  {t("forgotPassword.link")}
                </Link>
              </div>
            )}
            <button
              type="submit"
              disabled={submitting || !email || !password}
              className="w-full bg-gray-900 text-white px-6 py-3 rounded-md font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? t("submitting") : t("cta")}
            </button>
          </form>

          {loaderData.signupEnabled && (
            <div className="mt-3 flex justify-end text-xs text-gray-500">
              <Link to="/signup" className="hover:text-gray-700 underline">
                {t("noAccountSignUp")}
              </Link>
            </div>
          )}

          {loaderData.passkeyEnabled && (
            <>
              <div className="flex items-center gap-3 my-6 text-xs text-gray-400">
                <span className="flex-1 border-t" />
                <span>{t("email.or")}</span>
                <span className="flex-1 border-t" />
              </div>

              <div className="space-y-3">
                <button
                  type="button"
                  onClick={handlePasskey}
                  disabled={submitting}
                  className="inline-flex items-center justify-center gap-2 w-full bg-white text-gray-900 border border-gray-300 px-6 py-3 rounded-md font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15 7a4 4 0 11-8 0 4 4 0 018 0zm-4 7a7 7 0 00-7 7h14a7 7 0 00-7-7zm9-3l-3 3m0 0l-3-3m3 3V4"
                    />
                  </svg>
                  {t("passkey")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <LandingFooter />
    </div>
  );
}
