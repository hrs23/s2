import { Pencil } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/button";
import type { AccessPath, InternalApiToken as ApiToken } from "~/lib/api";
import { joinPaths } from "~/lib/files/paths";
import { formatDate } from "~/lib/utils/format";

function AccessPathBadges({ ap }: { ap: AccessPath }) {
  const { t } = useTranslation("access-paths");
  return (
    <span className="inline-flex gap-1">
      {ap.access === "write" ? (
        <span className="inline-block bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded text-xs font-medium">
          {t("access.write")}
        </span>
      ) : (
        <span className="inline-block bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-xs font-medium">
          {t("access.read")}
        </span>
      )}
    </span>
  );
}

export function TokenCardList({
  tokens,
  onDelete,
  onIssueOrRotate,
  onSettings,
  highlightId,
}: {
  tokens: ApiToken[];
  onDelete: (token: ApiToken) => void;
  onIssueOrRotate: (token: ApiToken) => void;
  onSettings: (token: ApiToken) => void;
  highlightId?: string;
}) {
  const { t } = useTranslation("tokens");
  if (tokens.length === 0) {
    return <p className="text-gray-500 text-sm">{t("noTokens")}</p>;
  }
  return (
    <div className="grid gap-4">
      {tokens.map((t) => (
        <TokenCard
          key={t.id}
          apiToken={t}
          onDelete={() => onDelete(t)}
          onIssueOrRotate={() => onIssueOrRotate(t)}
          onSettings={() => onSettings(t)}
          highlighted={t.id === highlightId}
        />
      ))}
    </div>
  );
}

function TokenCard({
  apiToken,
  onDelete,
  onIssueOrRotate,
  onSettings,
  highlighted = false,
}: {
  apiToken: ApiToken;
  onDelete: () => void;
  onIssueOrRotate: () => void;
  onSettings: () => void;
  highlighted?: boolean;
}) {
  const { t } = useTranslation("tokens");
  const cardRef = useRef<HTMLDivElement>(null);
  const expired =
    apiToken.has_active_secret && apiToken.token_expires_at
      ? new Date(apiToken.token_expires_at) < new Date()
      : false;

  useEffect(() => {
    if (highlighted && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlighted]);

  return (
    <div
      ref={cardRef}
      className={`rounded-lg border bg-white p-4 transition-colors duration-700 ${
        highlighted
          ? "border-violet-400 ring-2 ring-violet-200"
          : "border-gray-200"
      }`}
    >
      <div className="mb-1">
        <button
          type="button"
          className="group inline-flex items-center gap-1.5 text-base font-semibold text-gray-900 hover:text-blue-600 cursor-pointer text-left"
          onClick={onSettings}
        >
          {apiToken.name}
          <Pencil className="w-3.5 h-3.5 text-gray-300 group-hover:text-blue-500 transition-colors" />
        </button>
      </div>

      <div className="mb-2">
        {apiToken.has_active_secret && apiToken.token_expires_at ? (
          expired ? (
            <span className="flex items-center gap-1.5 text-sm">
              <span className="w-2 h-2 rounded-full bg-red-500 inline-block shrink-0" />
              <span className="text-red-600">
                {t("card.expired", {
                  date: formatDate(new Date(apiToken.token_expires_at)),
                })}
              </span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-sm">
              <span className="w-2 h-2 rounded-full bg-green-500 inline-block shrink-0" />
              <span className="text-gray-700">
                {t("card.active", {
                  date: formatDate(new Date(apiToken.token_expires_at)),
                })}
              </span>
            </span>
          )
        ) : null}
      </div>

      <div className="mb-3 text-sm space-y-0.5">
        {apiToken.access_paths.map((ap, i) => {
          const { base, suffix } = joinPaths(apiToken.base_path, ap.path);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: access_paths have no unique ID; path+index is the best stable key
            <div key={`${ap.path}-${i}`} className="flex items-center gap-1.5">
              <span className="font-mono">
                {base && <span className="text-gray-400">{base}</span>}
                <span className="text-gray-700">
                  {suffix || (base ? "" : "/")}
                </span>
              </span>
              <AccessPathBadges ap={ap} />
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">
          {t("card.created", {
            date: formatDate(new Date(apiToken.created_at)),
          })}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onIssueOrRotate}>
            {apiToken.has_active_secret ? t("card.rotate") : t("card.issue")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-red-500 hover:text-red-700"
            onClick={onDelete}
          >
            {t("card.delete")}
          </Button>
        </div>
      </div>
    </div>
  );
}
