// AtLimitView — shared "you've reached your access grant limit" surface.
//
// Used in two containers:
//   - /dashboard/tokens Create modal (user trying to make a manual token)
//   - /oauth/authorize consent (external app trying to get authorized)
// Lists every grant in the shared pool (manual + delegated + OAuth) with
// inline revoke so the user can free a slot without leaving the flow.

import { useState } from "react";
import { Button } from "~/components/ui/button";
import { type InternalApiToken as ApiToken, api } from "~/lib/api";
import type { OAuthGrantSummary } from "~/routes/internal.oauth-grants";

export interface AtLimitViewProps {
  tokens: ApiToken[];
  grants: OAuthGrantSummary[];
  count: number;
  limit: number;
  /** Called after a successful revoke so the parent can refetch state. */
  onRevoked: () => Promise<void> | void;
  /** Heading override (e.g. consent screen wants the client name). */
  heading?: string;
  description?: string;
}

export function AtLimitView({
  tokens,
  grants,
  count,
  limit,
  onRevoked,
  heading,
  description,
}: AtLimitViewProps) {
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function revoke(id: string, del: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try {
      await del();
      await onRevoked();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revoke failed");
    } finally {
      setBusyId(null);
    }
  }

  const revokeManual = (id: string) =>
    revoke(id, () => api.internal.tokens.delete(id));

  const revokeOAuth = (id: string) =>
    revoke(id, async () => {
      const res = await fetch(`/internal/oauth-grants/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `Failed (${res.status})`);
      }
    });

  const total = tokens.length + grants.length;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">
          {heading ?? "Access grant limit reached"}
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          {description ??
            `You're using ${count} of ${limit} access grants. Revoke an existing one to make room.`}
        </p>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {total === 0 ? (
        <p className="text-sm text-gray-500">No grants to revoke.</p>
      ) : (
        <ul className="divide-y rounded border bg-white">
          {tokens.map((tk) => (
            <li
              key={tk.id}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{tk.name}</div>
                <div className="text-xs text-gray-500">
                  API token · {tk.base_path}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => revokeManual(tk.id)}
                disabled={busyId === tk.id}
              >
                {busyId === tk.id ? "Revoking…" : "Revoke"}
              </Button>
            </li>
          ))}
          {grants.map((g) => (
            <li
              key={g.id}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {g.client_name}
                </div>
                <div className="text-xs text-gray-500">
                  Connected app · {g.base_path}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => revokeOAuth(g.id)}
                disabled={busyId === g.id}
              >
                {busyId === g.id ? "Revoking…" : "Revoke"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
