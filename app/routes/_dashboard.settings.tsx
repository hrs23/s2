import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { DangerZoneSection } from "~/components/account/danger-zone-section";
import { PasskeysSection } from "~/components/account/passkeys-section";
import { PasswordSection } from "~/components/account/password-section";
import { SessionsSection } from "~/components/account/sessions-section";
import { TwoFactorSection } from "~/components/account/two-factor-section";
import type { Route } from "./+types/_dashboard.settings";

export function meta() {
  return [{ title: "Settings | S2" }];
}

interface MeData {
  two_factor_enabled?: boolean;
  passkey_enabled?: boolean;
  totp_enabled?: boolean;
}

export async function clientLoader() {
  const res = await fetch("/internal/account");
  if (!res.ok) throw new Error("Failed to fetch");
  return res.json() as Promise<MeData>;
}

export function HydrateFallback() {
  const { t } = useTranslation("settings");
  return <p className="text-gray-500">{t("loading")}</p>;
}

function GroupHeading({
  children,
  tone = "default",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "default" | "danger";
  className?: string;
}) {
  return (
    <h2
      className={`text-xs font-semibold uppercase tracking-wider ${
        tone === "danger" ? "text-red-600" : "text-gray-500"
      } mb-2 ${className}`}
    >
      {children}
    </h2>
  );
}

export default function SettingsPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("settings");
  const me = loaderData;

  useEffect(() => {
    document.title = t("meta.title");
  }, [t]);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">{t("heading")}</h1>

      <GroupHeading>{t("groups.security")}</GroupHeading>
      <div className="space-y-3 mb-8">
        {me.passkey_enabled !== false && <PasskeysSection />}
        <PasswordSection />
        {me.totp_enabled !== false && (
          <TwoFactorSection initialEnabled={me.two_factor_enabled ?? false} />
        )}
        <SessionsSection />
      </div>

      <GroupHeading>{t("groups.system")}</GroupHeading>
      <div className="bg-white rounded-lg border border-gray-200 px-6 py-4 mb-8">
        <div className="flex items-center justify-between gap-4 text-sm">
          <span className="font-medium text-gray-700">
            {t("system.version")}
          </span>
          <span className="font-mono text-gray-500">{__S2_VERSION__}</span>
        </div>
      </div>

      <GroupHeading tone="danger">{t("groups.danger")}</GroupHeading>
      <div className="space-y-3">
        <DangerZoneSection />
      </div>
    </div>
  );
}
