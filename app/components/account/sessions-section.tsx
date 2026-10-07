import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/button";
import { authClient } from "~/lib/auth.client";
import { Card, relativeTime } from "./account-ui";

interface SessionRow {
  id: string;
  token: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  expiresAt: string | Date;
}

export function SessionsSection() {
  const { t } = useTranslation("settings");
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [currentToken, setCurrentToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [list, current] = await Promise.all([
      authClient.listSessions(),
      authClient.getSession(),
    ]);
    if (list.error) {
      setError("generic");
      return;
    }
    setSessions((list.data ?? []) as SessionRow[]);
    setCurrentToken(
      (current.data as { session?: { token?: string } } | null)?.session
        ?.token ?? null,
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function revoke(token: string) {
    setBusy(token);
    setError(null);
    try {
      const { error } = await authClient.revokeSession({ token });
      if (error) {
        setError("generic");
        return;
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function revokeOthers() {
    setBusy("others");
    setError(null);
    try {
      const { error } = await authClient.revokeOtherSessions();
      if (error) {
        setError("generic");
        return;
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title={t("sessions.title")}>
      {error && (
        <p className="mb-3 text-sm text-red-600">
          {t(`sessions.errors.${error}`, {
            defaultValue: t("sessions.errors.generic"),
          })}
        </p>
      )}
      <ul className="divide-y divide-gray-100 border border-gray-200 rounded-md mb-3">
        {sessions?.map((s) => {
          const isCurrent = s.token === currentToken;
          return (
            <li
              key={s.id}
              className="flex items-start justify-between p-3 gap-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {s.userAgent ?? "Unknown device"}
                  {isCurrent && (
                    <span className="ml-2 inline-block rounded-full bg-green-100 text-green-800 px-2 py-0.5 text-xs font-semibold">
                      {t("sessions.current")}
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500">
                  {s.ipAddress && (
                    <span>
                      {t("sessions.ipAddress", { ip: s.ipAddress })} ·{" "}
                    </span>
                  )}
                  <span>
                    {t("sessions.lastActive", {
                      when: relativeTime(s.updatedAt),
                    })}
                  </span>
                </p>
              </div>
              {!isCurrent && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === s.token}
                  onClick={() => revoke(s.token)}
                >
                  {t("sessions.revoke")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {sessions && sessions.length > 1 && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={revokeOthers}
        >
          {t("sessions.revokeOthers")}
        </Button>
      )}
    </Card>
  );
}
