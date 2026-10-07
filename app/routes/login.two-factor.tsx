// Two-factor verification page.
//
// Reached after a successful password sign-in for users with TOTP enabled:
// Better Auth returns `{ twoFactorRedirect: true }` and sets a short-lived
// `better-auth.two_factor` cookie (default 10 min). Until the user verifies
// here `getSession()` returns null — there is no session — so this page is
// the natural gate. We do NOT invent an "AAL1 session" intermediate state.
//
// The page accepts either:
//   - a 6-digit TOTP code from an authenticator app (default), or
//   - a recovery code (XXXXX-XXXXX) when the user lost their device
//
// Both call into the Better Auth twoFactor plugin via authClient.
// On success Better Auth issues the real session cookie; we trigger a full
// reload to /returnTo so loaders re-run.

import type { FormEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { redirect } from "react-router";
import { LandingFooter, LandingHeader } from "~/components/landing-content";
import { pageTitle } from "~/i18n/meta";
import { getRuntimeEnv } from "~/lib/app-load-context.server";
import { isTotpEnabled } from "~/lib/auth/auth-feature-policy";
import { authClient } from "~/lib/auth.client";
import type { Route } from "./+types/login.two-factor";

export async function loader({ context }: Route.LoaderArgs) {
  const env = getRuntimeEnv(context);
  if (!isTotpEnabled(env)) {
    return redirect("/login");
  }
  return null;
}
export function meta() {
  return [{ title: pageTitle("twoFactor") }];
}

type Mode = "totp" | "recovery";

export default function LoginTwoFactorPage() {
  const { t } = useTranslation("login");
  const [mode, setMode] = useState<Mode>("totp");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target =
    typeof window !== "undefined"
      ? (new URLSearchParams(window.location.search).get("returnTo") ?? "/")
      : "/";

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { error } =
        mode === "totp"
          ? await authClient.twoFactor.verifyTotp({ code })
          : await authClient.twoFactor.verifyBackupCode({ code });
      if (error) {
        setError(error.code ?? "INVALID_CODE");
        return;
      }
      // Full reload so loaders re-run with the freshly issued session cookie.
      window.location.assign(target);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <LandingHeader />
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="w-full max-w-sm text-center">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 mb-8">
            {t("twoFactor.heading")}
          </h1>

          {error && (
            <div className="mb-6 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {t(`twoFactor.errors.${error}`, {
                defaultValue: t("twoFactor.errors.generic"),
              })}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3 text-left">
            <div>
              <label
                htmlFor="code"
                className="block text-xs font-medium text-gray-700 mb-1"
              >
                {mode === "totp"
                  ? t("twoFactor.codeLabel")
                  : t("twoFactor.recoveryLabel")}
              </label>
              <input
                id="code"
                type="text"
                name="code"
                inputMode={mode === "totp" ? "numeric" : "text"}
                autoComplete={mode === "totp" ? "one-time-code" : "off"}
                pattern={mode === "totp" ? "[0-9]*" : undefined}
                required
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setError(null);
                }}
                placeholder={
                  mode === "totp"
                    ? t("twoFactor.codePlaceholder")
                    : t("twoFactor.recoveryPlaceholder")
                }
                className="w-full border border-gray-300 rounded-md px-4 py-3 focus:outline-none focus:ring-2 focus:ring-gray-900"
                maxLength={mode === "totp" ? 6 : 11}
              />
            </div>
            <button
              type="submit"
              disabled={submitting || !code}
              className="w-full bg-gray-900 text-white px-6 py-3 rounded-md font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? t("submitting") : t("twoFactor.cta")}
            </button>
          </form>

          <div className="mt-3 flex justify-center text-xs text-gray-500">
            <button
              type="button"
              onClick={() => {
                setMode((m) => (m === "totp" ? "recovery" : "totp"));
                setCode("");
                setError(null);
              }}
              className="hover:text-gray-700 underline"
            >
              {mode === "totp"
                ? t("twoFactor.useRecovery")
                : t("twoFactor.useTotp")}
            </button>
          </div>
        </div>
      </div>
      <LandingFooter />
    </div>
  );
}
