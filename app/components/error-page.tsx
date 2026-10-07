import { useTranslation } from "react-i18next";
import { Link } from "react-router";

export type ErrorPageVariant = "notFound" | "generic";

export function ErrorPage({
  variant,
  status,
}: {
  variant: ErrorPageVariant;
  status?: number;
}) {
  const { t } = useTranslation("common");
  const title =
    variant === "notFound" ? t("error.notFoundTitle") : t("error.genericTitle");
  const message =
    variant === "notFound"
      ? t("error.notFoundMessage")
      : t("error.genericMessage");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-white px-6 text-center">
      {status ? (
        <p className="mb-4 font-mono text-sm text-gray-400">{status}</p>
      ) : null}
      <h1 className="mb-4 text-3xl font-semibold text-gray-900">{title}</h1>
      <p className="mb-8 max-w-md text-gray-600">{message}</p>
      <Link
        to="/"
        className="rounded-md bg-gray-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-700"
      >
        {t("error.backHome")}
      </Link>
    </main>
  );
}
