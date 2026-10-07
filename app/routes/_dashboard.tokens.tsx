import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useRevalidator, useRouteLoaderData } from "react-router";
import { AtLimitDialog } from "~/components/access-grants/AtLimitDialog";
import { TokenCardList } from "~/components/tokens/TokenCard";
import type { TokenResult } from "~/components/tokens/TokenDialogs";
import {
  CreateTokenDialog,
  DeleteConfirmDialog,
  EditTokenDialog,
  IssueOrRotateDialog,
  TokenResultDialog,
} from "~/components/tokens/TokenDialogs";
import { Button } from "~/components/ui/button";
import {
  type AccessPath,
  type InternalApiToken as ApiToken,
  api,
} from "~/lib/api";
import type { Route } from "./+types/_dashboard.tokens";

export function meta() {
  return [{ title: "API Tokens | S2" }];
}

export async function clientLoader() {
  return api.internal.tokens.list();
}

export function HydrateFallback() {
  const { t } = useTranslation("tokens");
  return <p className="text-gray-500">{t("loading")}</p>;
}

export default function TokensPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("tokens");
  const { tokens, grant_count, grant_limit } = loaderData;
  const limitReached = grant_limit > 0 && grant_count >= grant_limit;
  const { revalidate } = useRevalidator();
  const location = useLocation();
  const dashboardData = useRouteLoaderData("routes/_dashboard") as
    | { appUrl: string }
    | undefined;
  const highlightId = location.hash ? location.hash.slice(1) : undefined;
  const [createOpen, setCreateOpen] = useState(false);
  const [atLimitOpen, setAtLimitOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiToken | null>(null);
  const [tokenResult, setTokenResult] = useState<TokenResult | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiToken | null>(null);
  const [secretTarget, setSecretTarget] = useState<ApiToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = t("meta.title");
  }, [t]);

  async function handleCreate(
    name: string,
    basePath: string,
    canDelegate: boolean,
    accessPaths: AccessPath[],
    expiresInDays: number,
  ) {
    const { raw_token, expires_at } = await api.internal.tokens.create(
      name,
      basePath,
      canDelegate,
      accessPaths,
      expiresInDays,
    );
    setTokenResult({ token: raw_token, expires_at });
    await revalidate();
  }

  function handleDeleteClick(apiToken: ApiToken) {
    setDeleteTarget(apiToken);
  }

  async function handleDeleteConfirm(id: string) {
    setDeleteTarget(null);
    try {
      await api.internal.tokens.delete(id);
      await revalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    }
  }

  async function handleIssueOrRotate(id: string, expiresInDays: number) {
    const target = secretTarget;
    setSecretTarget(null);
    try {
      const result = target?.has_active_secret
        ? await api.internal.tokens.rotateToken(id, expiresInDays)
        : await api.internal.tokens.issueToken(id, expiresInDays);
      setTokenResult(result);
      await revalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    }
  }

  async function handleUpdateToken(
    id: string,
    name: string,
    basePath: string,
    canDelegate: boolean,
    accessPaths: AccessPath[],
  ) {
    const editTarget = tokens.find((t: ApiToken) => t.id === id);
    const patch: { name?: string; base_path?: string; can_delegate?: boolean } =
      {};
    if (editTarget && name !== editTarget.name) patch.name = name;
    if (editTarget && basePath !== editTarget.base_path)
      patch.base_path = basePath;
    if (editTarget && canDelegate !== editTarget.can_delegate)
      patch.can_delegate = canDelegate;
    if (Object.keys(patch).length > 0) {
      await api.internal.tokens.update(id, patch);
    }
    await api.internal.tokens.updateAccessPaths(id, accessPaths);
    await revalidate();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{t("heading")}</h1>
        <div className="flex items-center gap-3">
          {grant_limit > 0 && (
            <span className="text-sm text-gray-500">
              {grant_count} / {grant_limit}
            </span>
          )}
          <Button
            onClick={() =>
              limitReached ? setAtLimitOpen(true) : setCreateOpen(true)
            }
          >
            {t("newToken")}
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => setError(null)}
          >
            {t("dismiss")}
          </button>
        </div>
      )}

      <TokenCardList
        tokens={tokens}
        onDelete={handleDeleteClick}
        onIssueOrRotate={setSecretTarget}
        onSettings={setEditTarget}
        highlightId={highlightId}
      />

      <CreateTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={handleCreate}
      />

      <AtLimitDialog
        open={atLimitOpen}
        onOpenChange={setAtLimitOpen}
        tokens={tokens}
        count={grant_count}
        limit={grant_limit}
        onRevoked={async () => {
          await revalidate();
        }}
      />

      <EditTokenDialog
        key={editTarget?.id ?? "closed"}
        apiToken={editTarget}
        onClose={() => setEditTarget(null)}
        onSubmit={handleUpdateToken}
      />

      <DeleteConfirmDialog
        apiToken={deleteTarget}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />

      <IssueOrRotateDialog
        apiToken={secretTarget}
        onConfirm={handleIssueOrRotate}
        onCancel={() => setSecretTarget(null)}
      />

      <TokenResultDialog
        result={tokenResult}
        onClose={() => setTokenResult(null)}
        appUrl={dashboardData?.appUrl}
      />
    </div>
  );
}
