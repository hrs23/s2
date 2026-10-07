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
import type { Route } from "./+types/reset-password";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getRuntimeEnv(context);
  if (!isEmailEnabled(env)) {
    return redirect("/login");
  }
  const user = await getUser(request, env);
  if (user) return redirect("/");

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const error = url.searchParams.get("error");
  return { token, error };
}

export function meta() {
  return [{ title: pageTitle("resetPassword") }];
}

export default function ResetPasswordPage({
  loaderData,
}: Route.ComponentProps) {
  const { t } = useTranslation("login");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(
    loaderData.error ? "INVALID_TOKEN" : null,
  );
  const [success, setSuccess] = useState(false);

  const token = loaderData.token;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!token) {
      setError("INVALID_TOKEN");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const { error } = await authClient.resetPassword({
        newPassword: password,
        token,
      });
      if (error) {
        setError(error.code ?? error.message ?? "reset_failed");
        return;
      }
      setSuccess(true);
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
            {t("resetPassword.heading")}
          </h1>

          {error && (
            <div className="mb-6 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {t(`resetPassword.errors.${error}`, {
                defaultValue: t("resetPassword.errors.generic"),
              })}
            </div>
          )}

          {success ? (
            <div className="space-y-4">
              <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
                {t("resetPassword.success")}
              </div>
              <Link
                to="/login"
                className="inline-block w-full bg-gray-900 text-white px-6 py-3 rounded-md font-medium hover:bg-gray-800 transition-colors"
              >
                {t("resetPassword.backToSignIn")}
              </Link>
            </div>
          ) : !token ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                {t("resetPassword.missingToken")}
              </p>
              <Link
                to="/forgot-password"
                className="inline-block text-xs text-gray-500 hover:text-gray-700 underline"
              >
                {t("resetPassword.requestNewLink")}
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3 text-left">
              <div>
                <label
                  htmlFor="password"
                  className="block text-xs font-medium text-gray-700 mb-1"
                >
                  {t("resetPassword.newPasswordLabel")}
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
                disabled={submitting || !password}
                className="w-full bg-gray-900 text-white px-6 py-3 rounded-md font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? t("submitting") : t("resetPassword.cta")}
              </button>
            </form>
          )}

          {!success && token && (
            <div className="mt-3 flex justify-center text-xs text-gray-500">
              <Link to="/login" className="hover:text-gray-700 underline">
                {t("resetPassword.backToSignIn")}
              </Link>
            </div>
          )}
        </div>
      </div>
      <LandingFooter />
    </div>
  );
}
