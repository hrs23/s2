// /connections — Connections page
//
// Lists OAuth grants, with per-grant paths/base_path editing and disconnect.
// Reuses the same AccessPathEditor / PathInputWithBrowse as the consent UI
// (/oauth/authorize).
//
// Each grant is one connection (per-install client_id), so there is no device
// hierarchy; grants sharing a client_name simply appear side by side.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRevalidator } from "react-router";
import {
  type AccessPath,
  AccessPathEditor,
  AccessPathsValidationError,
  accessPathsForSubmit,
  PathInputWithBrowse,
  validateAccessPaths,
} from "~/components/access-paths";
import { Button } from "~/components/ui/button";
import { validateBasePath } from "~/lib/files/paths";
import type { OAuthGrantSummary } from "./internal.oauth-grants";

// meta() runs before i18n is hydrated on the client; the dashboard pattern
// is to render an EN fallback here and switch via useEffect once mounted.
export function meta() {
  return [{ title: "Connections | S2" }];
}

export async function clientLoader() {
  const res = await fetch("/internal/oauth-grants", {
    credentials: "include",
  });
  if (!res.ok) {
    // i18n is not available in non-component scope; route loader errors
    // surface via <Response> message, which the router renders as plain
    // text. Keep the EN string here so the wire format is stable.
    throw new Response("Failed to load connections", { status: res.status });
  }
  const data = (await res.json()) as { grants: OAuthGrantSummary[] };
  return data;
}

export function HydrateFallback() {
  const { t } = useTranslation("connections");
  return <p className="text-gray-500">{t("loading")}</p>;
}

interface LoaderData {
  grants: OAuthGrantSummary[];
}

export default function Connections({
  loaderData,
}: {
  loaderData: LoaderData;
}) {
  const { t } = useTranslation("connections");
  const { grants } = loaderData;
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { revalidate } = useRevalidator();

  useEffect(() => {
    document.title = t("meta.title");
  }, [t]);

  async function handleDisconnect(grantId: string, appName: string) {
    if (!window.confirm(t("disconnect.confirm", { appName }))) {
      return;
    }
    setDisconnecting(grantId);
    setError(null);
    try {
      const res = await fetch(`/internal/oauth-grants/${grantId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(
          body || t("errors.requestFailed", { status: res.status }),
        );
      }
      revalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.disconnectFailed"));
    } finally {
      setDisconnecting(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-bold mb-6">{t("heading")}</h1>

      {error && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm">
          {error}
        </div>
      )}

      {grants.length === 0 ? (
        <p className="text-gray-500">{t("empty")}</p>
      ) : (
        <ul className="space-y-3">
          {grants.map((g) => (
            <li key={g.id} className="rounded border bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold break-words">{g.client_name}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    <time
                      dateTime={g.created_at}
                      title={formatDateTime(g.created_at)}
                    >
                      {t("connectedAt", {
                        when: formatRelative(g.created_at, t),
                      })}
                    </time>
                  </p>

                  {editing === g.id ? (
                    <GrantEditForm
                      grant={g}
                      onCancel={() => setEditing(null)}
                      onSaved={async () => {
                        await revalidate();
                        setEditing(null);
                      }}
                      onError={setError}
                    />
                  ) : (
                    <ReadOnlyPaths grant={g} />
                  )}
                </div>
                {editing !== g.id && (
                  <div className="flex flex-col gap-2 shrink-0">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setError(null);
                        setEditing(g.id);
                      }}
                    >
                      {t("actions.edit")}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => handleDisconnect(g.id, g.client_name)}
                      disabled={disconnecting === g.id}
                    >
                      {disconnecting === g.id
                        ? t("actions.disconnecting")
                        : t("actions.disconnect")}
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReadOnlyPaths({ grant }: { grant: OAuthGrantSummary }) {
  const { t } = useTranslation("connections");
  return (
    <div className="mt-2 text-sm">
      <div className="text-xs font-medium text-gray-600 mb-1">
        {t("fields.basePath")}
      </div>
      <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">
        {grant.base_path}
      </code>

      <div className="mt-2 text-xs font-medium text-gray-600 mb-1">
        {t("fields.allowedPaths")}
      </div>
      {grant.paths.length === 0 ? (
        <span className="text-xs text-gray-500">{t("fields.noPaths")}</span>
      ) : (
        <ul className="space-y-1">
          {grant.paths.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: small static list
            <li key={i} className="flex items-center gap-2">
              <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                {p.path}
              </code>
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${
                  p.access === "write"
                    ? "bg-blue-100 text-blue-700"
                    : "bg-gray-100 text-gray-700"
                }`}
              >
                {p.access}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GrantEditForm({
  grant,
  onCancel,
  onSaved,
  onError,
}: {
  grant: OAuthGrantSummary;
  onCancel: () => void;
  onSaved: () => Promise<void> | void;
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation("connections");
  const [basePath, setBasePath] = useState(grant.base_path);
  // an empty editor canonicalizes to "all under base_path".
  // Keep the existing rows when the grant already narrows the scope; the
  // submit handler applies accessPathsForSubmit before sending.
  const [accessPaths, setAccessPaths] = useState<AccessPath[]>(() =>
    grant.paths.map((p) => ({ path: p.path, access: p.access })),
  );
  const [saving, setSaving] = useState(false);

  const basePathErr = validateBasePath(basePath);
  const pathsErr = validateAccessPaths(accessPaths);
  const submitDisabled = saving || basePathErr !== null || pathsErr !== null;

  async function handleSave() {
    setSaving(true);
    onError(null);
    try {
      const res = await fetch(`/internal/oauth-grants/${grant.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_path: basePath,
          paths: accessPathsForSubmit(accessPaths),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(
          body || t("errors.requestFailed", { status: res.status }),
        );
      }
      // Keep saving=true through revalidate so the form stays open and
      // the user can't see stale data flash before the new state lands.
      await onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : t("errors.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset className="mt-2 rounded border bg-white p-3 space-y-3">
      <legend className="px-2 text-sm font-medium">{t("edit.legend")}</legend>

      <div>
        <p className="block text-sm font-medium text-gray-700 mb-1">
          {t("fields.basePath")}
        </p>
        <PathInputWithBrowse value={basePath} onChange={setBasePath} />
        {basePathErr && (
          <p className="mt-1 text-xs text-red-600">{basePathErr}</p>
        )}
      </div>

      <div>
        <p className="text-sm font-medium text-gray-700 mb-2">
          {t("fields.paths")}
        </p>
        <AccessPathEditor
          accessPaths={accessPaths}
          onChange={setAccessPaths}
          basePath={basePath}
        />
        <AccessPathsValidationError error={pathsErr} />
      </div>

      <div className="flex gap-2 pt-1">
        <Button type="button" onClick={handleSave} disabled={submitDisabled}>
          {saving ? t("actions.saving") : t("actions.save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
        >
          {t("actions.cancel")}
        </Button>
      </div>
    </fieldset>
  );
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Distinguish multiple recently-created grants from the same client —
 * recent items get relative phrasing with seconds; older items fall back
 * to date.
 */
function formatRelative(
  iso: string,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  let d: Date;
  try {
    d = new Date(iso);
  } catch {
    return iso;
  }
  const now = Date.now();
  const diffSec = Math.round((now - d.getTime()) / 1000);
  if (Number.isNaN(diffSec)) return iso;

  if (diffSec < 30) return t("relative.justNow");
  if (diffSec < 60) return t("relative.secondsAgo", { count: diffSec });
  if (diffSec < 3600)
    return t("relative.minutesAgo", { count: Math.floor(diffSec / 60) });

  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const sameDay = d.toDateString() === new Date(now).toDateString();
  if (sameDay) return t("relative.todayAt", { time });

  const diffDays = Math.floor(diffSec / 86400);
  if (diffDays < 7) return t("relative.daysAgoAt", { count: diffDays, time });

  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
