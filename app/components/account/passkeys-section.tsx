// Passkey management (AAL2 phishing-resistant).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/button";
import { authClient } from "~/lib/auth.client";
import { Card, relativeTime } from "./account-ui";

interface PasskeyRow {
  id: string;
  name: string | null;
  createdAt: string | Date;
  deviceType: string;
  backedUp: boolean;
}

export function PasskeysSection() {
  const { t } = useTranslation("settings");
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data, error } = await authClient.passkey.listUserPasskeys();
    if (error) {
      setError("list_failed");
      return;
    }
    setPasskeys((data ?? []) as PasskeyRow[]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function register() {
    if (typeof window === "undefined" || !window.PublicKeyCredential) {
      setError("unsupported");
      return;
    }
    setBusy("register");
    setError(null);
    try {
      // authClient.passkey.addPasskey() drives navigator.credentials.create()
      // and posts the attestation to /api/auth/passkey/verify-registration.
      const result = await authClient.passkey.addPasskey();
      if (result?.error) {
        setError("registration_failed");
        return;
      }
      await refresh();
    } catch {
      setError("registration_failed");
    } finally {
      setBusy(null);
    }
  }

  async function rename(id: string, currentName: string | null) {
    const next = window.prompt(t("passkeys.renamePrompt"), currentName ?? "");
    if (next === null || next === currentName) return;
    setBusy(id);
    setError(null);
    try {
      const { error } = await authClient.passkey.updatePasskey({
        id,
        name: next,
      });
      if (error) {
        setError("rename_failed");
        return;
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm(t("passkeys.deleteConfirm"))) return;
    setBusy(id);
    setError(null);
    try {
      const { error } = await authClient.passkey.deletePasskey({ id });
      if (error) {
        setError("delete_failed");
        return;
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title={t("passkeys.title")}>
      {error && (
        <p className="mb-3 text-sm text-red-600">
          {t(`passkeys.errors.${error}`)}
        </p>
      )}
      {passkeys && passkeys.length > 0 ? (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-md mb-3">
          {passkeys.map((pk) => (
            <li
              key={pk.id}
              className="flex items-start justify-between p-3 gap-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {pk.name ?? "Passkey"}
                </p>
                <p className="text-xs text-gray-500">
                  {t("passkeys.createdAt", {
                    when: relativeTime(pk.createdAt),
                  })}
                  {pk.backedUp && " · synced"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === pk.id}
                  onClick={() => rename(pk.id, pk.name)}
                >
                  {t("common.rename")}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy === pk.id}
                  onClick={() => remove(pk.id)}
                >
                  {t("common.delete")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : passkeys !== null ? (
        <p className="mb-3 text-sm text-gray-500">{t("passkeys.empty")}</p>
      ) : null}
      <Button type="button" disabled={busy === "register"} onClick={register}>
        {busy === "register"
          ? t("passkeys.registering")
          : t("passkeys.register")}
      </Button>
    </Card>
  );
}
