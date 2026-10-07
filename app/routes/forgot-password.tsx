import type { FormEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, redirect } from "react-router";
import { LandingFooter, LandingHeader } from "~/components/landing-content";
import { pageTitle } from "~/i18n/meta";
import { getRuntimeEnv } from "~/lib/app-load-context.server";
import { getUser } from "~/lib/auth/auth.server";
import { isEmailEnabled } from "~/lib/auth/auth-feature-policy";
import { authClient } from "~/lib/auth.client";
import type { Route } from "./+types/forgot-password";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getRuntimeEnv(context);
  if (!isEmailEnabled(env)) {
    return redirect("/login");
  }
  const user = await getUser(request, env);
  if (user) return redirect("/");
  return null;
}

export function meta() {
  return [{ title: pageTitle("forgotPassword") }];
}

export default function ForgotPasswordPage() {
  const { t } = useTranslation("login");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const redirectTo =
        typeof window !== "undefined"
          ? `${window.location.origin}/reset-password`
          : "/reset-password";
      const { error } = await authClient.requestPasswordReset({
        email,
        redirectTo,
      });
      if (error) {
        setError(error.code ?? error.message ?? "request_failed");
        return;
      }
      setSent(true);
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
            {t("forgotPassword.heading")}
          </h1>

          {error && (
            <div className="mb-6 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {t(`forgotPassword.errors.${error}`, {
                defaultValue: t("forgotPassword.errors.generic"),
              })}
            </div>
          )}

          {sent ? (
            <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
              {t("forgotPassword.sent")}
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
              <button
                type="submit"
                disabled={submitting || !email}
                className="w-full bg-gray-900 text-white px-6 py-3 rounded-md font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? t("submitting") : t("forgotPassword.cta")}
              </button>
            </form>
          )}

          <div className="mt-3 flex justify-center text-xs text-gray-500">
            <Link to="/login" className="hover:text-gray-700 underline">
              {t("forgotPassword.backToSignIn")}
            </Link>
          </div>
        </div>
      </div>
      <LandingFooter />
    </div>
  );
}
