// Modal wrapper around AtLimitView for the dashboard "Create" flow. The
// dashboard already has the manual tokens loaded; OAuth grants are fetched
// lazily when the dialog opens.

import { useEffect, useState } from "react";
import { Dialog } from "~/components/ui/dialog";
import type { InternalApiToken as ApiToken } from "~/lib/api";
import type { OAuthGrantSummary } from "~/routes/internal.oauth-grants";
import { AtLimitView } from "./AtLimitView";

export function AtLimitDialog({
  open,
  onOpenChange,
  tokens,
  count,
  limit,
  onRevoked,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tokens: ApiToken[];
  count: number;
  limit: number;
  onRevoked: () => Promise<void> | void;
}) {
  const [grants, setGrants] = useState<OAuthGrantSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setGrants(null);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    fetch("/internal/oauth-grants", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Failed to load (${r.status})`);
        const data = (await r.json()) as { grants: OAuthGrantSummary[] };
        if (!cancelled) setGrants(data.grants);
      })
      .catch((e) => {
        if (!cancelled)
          setLoadError(e instanceof Error ? e.message : "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      {loadError ? (
        <p className="text-sm text-red-600">{loadError}</p>
      ) : grants === null ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <AtLimitView
          tokens={tokens}
          grants={grants}
          count={count}
          limit={limit}
          onRevoked={onRevoked}
        />
      )}
    </Dialog>
  );
}
