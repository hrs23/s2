import type { FormEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, redirect } from "react-router";
import { LandingFooter, LandingHeader } from "~/components/landing-content";
import { pageTitle } from "~/i18n/meta";
import { getRuntimeEnv } from "~/lib/app-load-context.server";
import { getUser } from "~/lib/auth/auth.server";
import {
  isEmailEnabled,
  isSignupEnabled,
} from "~/lib/auth/auth-feature-policy";
import { authClient } from "~/lib/auth.client";
import type { Route } from "./+types/signup";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getRuntimeEnv(context);
  const user = await getUser(request, env);
  if (user) return redirect("/");
  if (!isSignupEnabled(env)) return redirect("/login");
  return { emailEnabled: isEmailEnabled(env) };
}

export function meta() {
  return [{ title: pageTitle("signup") }];
}

export default function SignupPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verificationSent, setVerificationSent] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // Better Auth's canonical password sign-up. Self-host mode has no
      // external email dependency, so the session is available immediately.
      // Better Auth's `signUp.email` zod schema requires a `name` key but
      // accepts the empty string. We don't collect names — the column is
      // populated only when an OAuth provider supplies one. Matches Better
      // Auth's own `name || ""` convention (issues #424 / #2067 / #3222).
      const { data, error } = await authClient.signUp.email({
        email,
        password,
        name: "",
        callbackURL: "/login?verified=1",
      });
      if (error) {
        setError(error.code ?? error.message ?? "signup_failed");
        return;
      }
      if (
        loaderData.emailEnabled &&
        (data as { token?: string | null } | null)?.token == null
      ) {
        setVerificationSent(true);
        return;
      }
      window.location.assign("/");
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
            {t("signup.heading")}
          </h1>

          {error && (
            <div className="mb-6 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {t(`errors.${error}`, {
                defaultValue: t("error", { error }),
              })}
            </div>
          )}

          {verificationSent ? (
            <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
              {t("signup.verificationSent", { email })}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3 text-left">
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
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-4 py-3 focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
              </div>
              <button
                type="submit"
                disabled={submitting || !email || !password}
                className="w-full bg-gray-900 text-white px-6 py-3 rounded-md font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? t("submitting") : t("signup.cta")}
              </button>
            </form>
          )}

          {!verificationSent && (
            <div className="mt-3 flex justify-end text-xs text-gray-500">
              <Link to="/login" className="hover:text-gray-700 underline">
                {t("signup.haveAccount")} {t("signup.signIn")}
              </Link>
            </div>
          )}
          {verificationSent && (
            <div className="mt-3 flex justify-center text-xs text-gray-500">
              <Link to="/login" className="hover:text-gray-700 underline">
                {t("signup.signIn")}
              </Link>
            </div>
          )}
        </div>
      </div>
      <LandingFooter />
    </div>
  );
}
