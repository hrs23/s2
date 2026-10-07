// TOTP + recovery codes.

import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/button";
import { authClient } from "~/lib/auth.client";
import { cn } from "~/lib/utils/cn";
import { Card, Input } from "./account-ui";

type TwoFactorStep =
  | { kind: "idle" }
  | { kind: "enroll-password" }
  | {
      kind: "enroll-verify";
      totpURI: string;
      secret: string;
      backupCodes: string[];
    }
  | { kind: "enroll-codes"; backupCodes: string[] }
  | { kind: "disable-password" }
  | { kind: "regenerate-password" }
  | { kind: "regenerate-codes"; backupCodes: string[] };

// otpauth://totp/Issuer:account?secret=BASE32&issuer=Issuer&...
function extractTotpSecret(uri: string): string {
  try {
    const queryStart = uri.indexOf("?");
    if (queryStart < 0) return "";
    const params = new URLSearchParams(uri.slice(queryStart + 1));
    return params.get("secret") ?? "";
  } catch {
    return "";
  }
}

export function TwoFactorSection({
  initialEnabled,
}: {
  initialEnabled: boolean;
}) {
  const { t } = useTranslation("settings");
  const [enabled, setEnabled] = useState<boolean>(initialEnabled);
  const [step, setStep] = useState<TwoFactorStep>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [acked, setAcked] = useState(false);

  // Lazy-load `qrcode` so the dashboard bundle doesn't pay for it on the
  // common path.
  useEffect(() => {
    if (step.kind !== "enroll-verify") {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const qrcode = (await import("qrcode")).default;
      const dataUrl = await qrcode.toDataURL(step.totpURI, {
        width: 200,
        margin: 1,
      });
      if (!cancelled) setQrDataUrl(dataUrl);
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

  function reset() {
    setStep({ kind: "idle" });
    setPassword("");
    setCode("");
    setError(null);
    setAcked(false);
    setBusy(false);
  }

  async function startEnable() {
    setStep({ kind: "enroll-password" });
    setError(null);
  }

  async function submitEnablePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Better Auth /two-factor/enable returns { totpURI, backupCodes[] } and
      // marks `verified=false` until the first verifyTotp succeeds.
      const { data, error } = await authClient.twoFactor.enable({ password });
      if (error || !data) {
        setError(error?.code ?? "generic");
        return;
      }
      const secret = extractTotpSecret(data.totpURI);
      setStep({
        kind: "enroll-verify",
        totpURI: data.totpURI,
        secret,
        backupCodes: data.backupCodes,
      });
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  async function submitVerifyTotp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step.kind !== "enroll-verify") return;
    setError(null);
    setBusy(true);
    try {
      const { error } = await authClient.twoFactor.verifyTotp({ code });
      if (error) {
        setError(error.code ?? "INVALID_CODE");
        return;
      }
      setEnabled(true);
      setStep({ kind: "enroll-codes", backupCodes: step.backupCodes });
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  async function submitDisable(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { error } = await authClient.twoFactor.disable({ password });
      if (error) {
        setError(error.code ?? "generic");
        return;
      }
      setEnabled(false);
      reset();
    } finally {
      setBusy(false);
    }
  }

  async function submitRegenerate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { data, error } = await authClient.twoFactor.generateBackupCodes({
        password,
      });
      if (error || !data) {
        setError(error?.code ?? "generic");
        return;
      }
      setStep({ kind: "regenerate-codes", backupCodes: data.backupCodes });
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  function copyCodes(codes: string[]) {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(codes.join("\n"));
  }

  function downloadCodes(codes: string[]) {
    if (typeof window === "undefined") return;
    const blob = new Blob([`${codes.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "s2-recovery-codes.txt";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <Card title={t("twoFactor.title")}>
      {error && (
        <p className="mb-3 text-sm text-red-600">
          {t(`twoFactor.errors.${error}`, {
            defaultValue: t("twoFactor.errors.generic"),
          })}
        </p>
      )}

      {step.kind === "idle" && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-700">
            <span
              className={cn(
                "inline-block rounded-full px-2 py-0.5 text-xs font-semibold",
                enabled
                  ? "bg-green-100 text-green-800"
                  : "bg-gray-100 text-gray-700",
              )}
            >
              {enabled
                ? t("twoFactor.statusEnabled")
                : t("twoFactor.statusDisabled")}
            </span>
          </p>
          <div className="flex items-center gap-2">
            {enabled ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setStep({ kind: "regenerate-password" })}
                >
                  {t("twoFactor.regenerateButton")}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setStep({ kind: "disable-password" })}
                >
                  {t("twoFactor.disableButton")}
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={startEnable}>
                {t("twoFactor.enable")}
              </Button>
            )}
          </div>
        </div>
      )}

      {step.kind === "enroll-password" && (
        <form onSubmit={submitEnablePassword} className="space-y-3 max-w-md">
          <h3 className="text-sm font-semibold text-gray-900">
            {t("twoFactor.step1.heading")}
          </h3>
          <Input
            id="tf-enable-password"
            type="password"
            autoComplete="current-password"
            label={t("twoFactor.step1.passwordLabel")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !password}>
              {t("twoFactor.step1.next")}
            </Button>
            <Button type="button" variant="outline" onClick={reset}>
              {t("twoFactor.cancel")}
            </Button>
          </div>
        </form>
      )}

      {step.kind === "enroll-verify" && (
        <form onSubmit={submitVerifyTotp} className="space-y-3 max-w-md">
          <h3 className="text-sm font-semibold text-gray-900">
            {t("twoFactor.step2.heading")}
          </h3>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="TOTP QR code"
              className="border border-gray-200 rounded-md"
              width={200}
              height={200}
            />
          ) : (
            <div className="w-[200px] h-[200px] bg-gray-100 rounded-md" />
          )}
          {step.secret && (
            <div>
              <label
                htmlFor="tf-secret"
                className="block text-xs font-medium text-gray-700 mb-1"
              >
                {t("twoFactor.step2.secretLabel")}
              </label>
              <code
                id="tf-secret"
                className="block w-full font-mono text-sm bg-gray-50 border border-gray-200 rounded-md px-3 py-2 break-all"
              >
                {step.secret}
              </code>
            </div>
          )}
          <Input
            id="tf-totp-code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            label={t("twoFactor.step2.codeLabel")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            maxLength={6}
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || code.length < 6}>
              {t("twoFactor.step2.verify")}
            </Button>
            <Button type="button" variant="outline" onClick={reset}>
              {t("twoFactor.cancel")}
            </Button>
          </div>
        </form>
      )}

      {(step.kind === "enroll-codes" || step.kind === "regenerate-codes") && (
        <div className="space-y-3 max-w-md">
          <h3 className="text-sm font-semibold text-gray-900">
            {t("twoFactor.step3.heading")}
          </h3>
          <p className="text-sm text-gray-500">
            {t("twoFactor.step3.description")}
          </p>
          <ul className="grid grid-cols-2 gap-2 font-mono text-sm bg-gray-50 border border-gray-200 rounded-md p-3">
            {step.backupCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copyCodes(step.backupCodes)}
            >
              {t("twoFactor.step3.copy")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadCodes(step.backupCodes)}
            >
              {t("twoFactor.step3.download")}
            </Button>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={acked}
              onChange={(e) => setAcked(e.target.checked)}
            />
            {t("twoFactor.step3.ack")}
          </label>
          <Button type="button" disabled={!acked} onClick={reset}>
            {t("twoFactor.step3.done")}
          </Button>
        </div>
      )}

      {step.kind === "disable-password" && (
        <form onSubmit={submitDisable} className="space-y-3 max-w-md">
          <h3 className="text-sm font-semibold text-gray-900">
            {t("twoFactor.disablePanel.heading")}
          </h3>
          <p className="text-sm text-gray-500">
            {t("twoFactor.disablePanel.description")}
          </p>
          <Input
            id="tf-disable-password"
            type="password"
            autoComplete="current-password"
            label={t("twoFactor.step1.passwordLabel")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="destructive"
              disabled={busy || !password}
            >
              {t("twoFactor.disablePanel.confirm")}
            </Button>
            <Button type="button" variant="outline" onClick={reset}>
              {t("twoFactor.cancel")}
            </Button>
          </div>
        </form>
      )}

      {step.kind === "regenerate-password" && (
        <form onSubmit={submitRegenerate} className="space-y-3 max-w-md">
          <h3 className="text-sm font-semibold text-gray-900">
            {t("twoFactor.regeneratePanel.heading")}
          </h3>
          <p className="text-sm text-gray-500">
            {t("twoFactor.regeneratePanel.description")}
          </p>
          <Input
            id="tf-regen-password"
            type="password"
            autoComplete="current-password"
            label={t("twoFactor.step1.passwordLabel")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !password}>
              {t("twoFactor.regeneratePanel.confirm")}
            </Button>
            <Button type="button" variant="outline" onClick={reset}>
              {t("twoFactor.cancel")}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
