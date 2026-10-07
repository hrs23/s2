import { ArrowLeft, ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

export const DOCS_NAV = [
  { page: "index", to: "/docs", labelKey: "nav.gettingStarted" },
  { page: "rest", to: "/docs/rest", labelKey: "nav.restApi" },
  { page: "mcp", to: "/docs/mcp", labelKey: "nav.mcp" },
  { page: "webdav", to: "/docs/webdav", labelKey: "nav.webdav" },
] as const;

type DocsPage = (typeof DOCS_NAV)[number]["page"];

export function DocsPager({ current }: { current: DocsPage }) {
  const { t } = useTranslation("docs");
  const idx = DOCS_NAV.findIndex((item) => item.page === current);
  const prev = idx > 0 ? DOCS_NAV[idx - 1] : null;
  const next = idx < DOCS_NAV.length - 1 ? DOCS_NAV[idx + 1] : null;

  return (
    <nav className="mt-12 pt-6 border-t border-gray-200 grid grid-cols-2 gap-3 text-sm">
      {prev ? (
        <Link
          to={prev.to}
          className="group flex items-center gap-2 p-3 rounded-md border border-gray-200 hover:bg-gray-50 transition-colors"
        >
          <ArrowLeft
            className="w-4 h-4 text-gray-400 group-hover:text-gray-600"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-xs text-gray-500">{t("pager.prev")}</p>
            <p className="font-medium text-gray-900 truncate">
              {t(prev.labelKey)}
            </p>
          </div>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          to={next.to}
          className="group flex items-center justify-end gap-2 p-3 rounded-md border border-gray-200 hover:bg-gray-50 transition-colors text-right"
        >
          <div className="min-w-0">
            <p className="text-xs text-gray-500">{t("pager.next")}</p>
            <p className="font-medium text-gray-900 truncate">
              {t(next.labelKey)}
            </p>
          </div>
          <ArrowRight
            className="w-4 h-4 text-gray-400 group-hover:text-gray-600 flex-shrink-0"
            aria-hidden="true"
          />
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
