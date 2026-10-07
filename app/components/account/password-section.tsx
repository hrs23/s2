import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/button";
import { authClient } from "~/lib/auth.client";
import { Card, Input } from "./account-ui";

export function PasswordSection() {
  return <ChangePasswordCard />;
}

function ChangePasswordCard() {
  const { t } = useTranslation("settings");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setSubmitting(true);
    try {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: false,
      });
      if (error) {
        setError(error.code ?? "generic");
        return;
      }
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card title={t("password.title")}>
      <form onSubmit={handleSubmit} className="space-y-3 max-w-md">
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          label={t("password.currentLabel")}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
        />
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          label={t("password.newLabel")}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={8}
        />
        {error && (
          <p className="text-sm text-red-600">
            {t(`password.errors.${error}`, {
              defaultValue: t("password.errors.generic"),
            })}
          </p>
        )}
        {success && (
          <p className="text-sm text-green-700">{t("password.success")}</p>
        )}
        <Button
          type="submit"
          disabled={submitting || !currentPassword || !newPassword}
        >
          {submitting ? t("common.saving") : t("password.submit")}
        </Button>
      </form>
    </Card>
  );
}
