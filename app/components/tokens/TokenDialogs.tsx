import { Copy, Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  type AccessPath,
  AccessPathEditor,
  AccessPathsValidationError,
  accessPathsForSubmit,
  PathInputWithBrowse,
  validateAccessPaths,
} from "~/components/access-paths";
import { Button } from "~/components/ui/button";
import { Dialog, DialogFooter, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import type { InternalApiToken as ApiToken } from "~/lib/api";
import { validateBasePath } from "~/lib/files/paths";
import { formatDate } from "~/lib/utils/format";

// --- Expiry presets ---

const EXPIRY_PRESET_KEYS = [
  { key: "create.days7", days: 7 },
  { key: "create.days30", days: 30 },
  { key: "create.days90", days: 90 },
  { key: "create.year1", days: 365 },
] as const;

function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function ExpirySelector({
  expiresInDays,
  customDate,
  isCustom,
  onSelectPreset,
  onSelectCustom,
  onCustomDateChange,
}: {
  expiresInDays: number;
  customDate: string;
  isCustom: boolean;
  onSelectPreset: (days: number) => void;
  onSelectCustom: () => void;
  onCustomDateChange: (value: string) => void;
}) {
  const { t } = useTranslation("tokens");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const maxDate = new Date();
  maxDate.setFullYear(maxDate.getFullYear() + 1);

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        {t("create.expiration")}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {EXPIRY_PRESET_KEYS.map((opt) => (
          <button
            key={opt.days}
            type="button"
            className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
              !isCustom && expiresInDays === opt.days
                ? "bg-blue-600 text-white border-blue-600"
                : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
            }`}
            onClick={() => onSelectPreset(opt.days)}
          >
            {t(opt.key)}
          </button>
        ))}
        <button
          type="button"
          className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
            isCustom
              ? "bg-blue-600 text-white border-blue-600"
              : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
          }`}
          onClick={onSelectCustom}
        >
          {t("create.custom")}
        </button>
      </div>
      {isCustom && (
        <div className="mt-2">
          <Input
            type="date"
            value={customDate}
            min={toDateInputValue(tomorrow)}
            max={toDateInputValue(maxDate)}
            onChange={(e) => onCustomDateChange(e.target.value)}
            className="w-48 text-sm"
          />
        </div>
      )}
    </div>
  );
}

function useExpiryState(defaultDays = 90) {
  const [expiresInDays, setExpiresInDays] = useState(defaultDays);
  const [isCustom, setIsCustom] = useState(false);
  const [customDate, setCustomDate] = useState("");

  function selectPreset(days: number) {
    setExpiresInDays(days);
    setIsCustom(false);
    setCustomDate("");
  }

  function selectCustom() {
    setIsCustom(true);
  }

  function getExpiresInDays(): number {
    if (isCustom && customDate) {
      const target = new Date(`${customDate}T00:00:00`);
      const now = new Date();
      return Math.max(
        1,
        Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      );
    }
    return expiresInDays;
  }

  function reset() {
    setExpiresInDays(defaultDays);
    setIsCustom(false);
    setCustomDate("");
  }

  return {
    expiresInDays,
    isCustom,
    customDate,
    selectPreset,
    selectCustom,
    setCustomDate,
    getExpiresInDays,
    reset,
  };
}

// --- Token Result type ---

export interface TokenResult {
  token: string;
  expires_at: string;
}

// --- Create Token Dialog ---

export function CreateTokenDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (
    name: string,
    basePath: string,
    canDelegate: boolean,
    accessPaths: AccessPath[],
    expiresInDays: number,
  ) => Promise<void>;
}) {
  const { t } = useTranslation("tokens");
  const [name, setName] = useState("my-app");
  const [basePath, setBasePath] = useState("/");
  const [canDelegate, setCanDelegate] = useState(false);
  const [accessPaths, setAccessPaths] = useState<AccessPath[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const expiry = useExpiryState(90);

  function handleClose(v: boolean) {
    if (!v) {
      setName("my-app");
      setBasePath("/");
      setCanDelegate(false);
      setAccessPaths([]);
      setError(null);
      setAdvancedOpen(false);
      expiry.reset();
    }
    onOpenChange(v);
  }

  const pathErr = validateAccessPaths(accessPaths);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const basePathErr = validateBasePath(basePath);
    if (basePathErr) {
      setError(basePathErr);
      return;
    }
    if (pathErr !== null) return;
    setError(null);
    setSubmitting(true);
    try {
      // Empty editor → canonical "all under base_path".
      await onSubmit(
        name.trim(),
        basePath,
        canDelegate,
        accessPathsForSubmit(accessPaths),
        expiry.getExpiresInDays(),
      );
      setName("my-app");
      setBasePath("/");
      setCanDelegate(false);
      setAccessPaths([]);
      setAdvancedOpen(false);
      expiry.reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTitle>{t("create.title")}</DialogTitle>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error}
          </p>
        )}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t("create.name")}
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("create.namePlaceholder")}
            autoComplete="off"
            data-1p-ignore
            autoFocus
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t("create.basePath")}
          </label>
          <PathInputWithBrowse
            value={basePath}
            onChange={(v) => {
              setBasePath(v);
              setError(null);
            }}
          />
        </div>
        <div>
          <p className="text-sm font-medium text-gray-700 mb-2">
            {t("create.accessPaths")}
          </p>
          <AccessPathEditor
            accessPaths={accessPaths}
            onChange={setAccessPaths}
            basePath={basePath}
          />
          <AccessPathsValidationError error={pathErr} />
        </div>
        <ExpirySelector
          expiresInDays={expiry.expiresInDays}
          customDate={expiry.customDate}
          isCustom={expiry.isCustom}
          onSelectPreset={expiry.selectPreset}
          onSelectCustom={expiry.selectCustom}
          onCustomDateChange={expiry.setCustomDate}
        />
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-sm font-medium text-gray-700 hover:text-gray-900"
            onClick={() => setAdvancedOpen(!advancedOpen)}
          >
            <span className="text-xs">
              {advancedOpen ? "\u25BC" : "\u25B6"}
            </span>
            {t("create.advanced")}
          </button>
          {advancedOpen && (
            <div className="mt-3 space-y-3 pl-4 border-l-2 border-gray-100">
              <div>
                <label className="flex items-center gap-2 text-sm select-none">
                  <input
                    type="checkbox"
                    checked={canDelegate}
                    onChange={(e) => setCanDelegate(e.target.checked)}
                  />
                  <span className="font-medium text-gray-700">
                    {t("create.allowDelegate")}
                  </span>
                </label>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleClose(false)}
          >
            {t("create.cancel")}
          </Button>
          <Button
            type="submit"
            disabled={submitting || !name.trim() || pathErr !== null}
          >
            {submitting ? t("create.creating") : t("create.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

// --- Edit (Settings) Dialog ---

export function EditTokenDialog({
  apiToken,
  onClose,
  onSubmit,
}: {
  apiToken: ApiToken | null;
  onClose: () => void;
  onSubmit: (
    id: string,
    name: string,
    basePath: string,
    canDelegate: boolean,
    accessPaths: AccessPath[],
  ) => Promise<void>;
}) {
  const { t } = useTranslation("tokens");
  // State is initialized once on mount. The call site passes
  // `key={apiToken.id}` so this component remounts when the user opens a
  // different token, which gives a fresh local draft. The previous shape
  // re-synced from props on every render and collided with legitimate empty
  // user input — clearing basePath or removing all access paths got reverted.
  const [name, setName] = useState(apiToken?.name ?? "");
  const [basePath, setBasePath] = useState(apiToken?.base_path ?? "");
  const [canDelegate, setCanDelegate] = useState(
    apiToken?.can_delegate ?? false,
  );
  const [accessPaths, setAccessPaths] = useState<AccessPath[]>(() =>
    apiToken ? apiToken.access_paths.map((p) => ({ ...p })) : [],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pathErr = validateAccessPaths(accessPaths);

  if (!apiToken) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiToken) return;
    if (!name.trim()) return;
    if (pathErr !== null) return;
    const basePathErr = validateBasePath(basePath);
    if (basePathErr) {
      setError(basePathErr);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // Empty editor → canonical "all under base_path".
      await onSubmit(
        apiToken.id,
        name.trim(),
        basePath,
        canDelegate,
        accessPathsForSubmit(accessPaths),
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={!!apiToken} onOpenChange={(v) => !v && onClose()}>
      <DialogTitle>{t("edit.title")}</DialogTitle>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error}
          </p>
        )}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t("edit.name")}
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("create.namePlaceholder")}
            autoComplete="off"
            data-1p-ignore
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t("edit.basePath")}
          </label>
          <PathInputWithBrowse
            value={basePath}
            onChange={(v) => {
              setBasePath(v);
              setError(null);
            }}
          />
        </div>
        <div>
          <p className="text-sm font-medium text-gray-700 mb-2">
            {t("edit.accessPaths")}
          </p>
          <AccessPathEditor
            accessPaths={accessPaths}
            onChange={setAccessPaths}
            basePath={basePath}
          />
          <AccessPathsValidationError error={pathErr} />
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm select-none">
            <input
              type="checkbox"
              checked={canDelegate}
              onChange={(e) => setCanDelegate(e.target.checked)}
            />
            <span className="font-medium text-gray-700">
              {t("edit.allowDelegate")}
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("edit.cancel")}
          </Button>
          <Button
            type="submit"
            disabled={submitting || !name.trim() || pathErr !== null}
          >
            {submitting ? t("edit.saving") : t("edit.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

// --- Issue / Rotate Dialog ---
//
// One dialog surface covers both "first-time issue" and "rotate existing
// secret". The caller decides which backend verb to invoke based on
// `apiToken.has_active_secret`; the dialog just mirrors that state in the
// copy (issue.* vs rotate.* i18n keys) and button severity.

export function IssueOrRotateDialog({
  apiToken,
  onConfirm,
  onCancel,
}: {
  apiToken: ApiToken | null;
  onConfirm: (id: string, expiresInDays: number) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("tokens");
  const expiry = useExpiryState(90);
  if (!apiToken) return null;
  const isRotate = apiToken.has_active_secret;
  const ns = isRotate ? "rotate" : "issue";
  return (
    <Dialog open={!!apiToken} onOpenChange={(v) => !v && onCancel()}>
      <DialogTitle>{t(`${ns}.title`)}</DialogTitle>
      <div className="space-y-3 text-sm">
        <p>
          <Trans
            i18nKey={`${ns}.description`}
            ns="tokens"
            values={{ name: apiToken.name }}
            components={{ strong: <span className="font-medium" /> }}
          />
        </p>
        <ExpirySelector
          expiresInDays={expiry.expiresInDays}
          customDate={expiry.customDate}
          isCustom={expiry.isCustom}
          onSelectPreset={expiry.selectPreset}
          onSelectCustom={expiry.selectCustom}
          onCustomDateChange={expiry.setCustomDate}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t(`${ns}.cancel`)}
        </Button>
        <Button
          variant={isRotate ? "destructive" : "default"}
          onClick={() => onConfirm(apiToken.id, expiry.getExpiresInDays())}
        >
          {t(`${ns}.confirm`)}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// --- Delete Dialog ---

export function DeleteConfirmDialog({
  apiToken,
  onConfirm,
  onCancel,
}: {
  apiToken: ApiToken | null;
  onConfirm: (id: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("tokens");
  if (!apiToken) return null;
  return (
    <Dialog open={!!apiToken} onOpenChange={(v) => !v && onCancel()}>
      <DialogTitle>{t("deleteDialog.title")}</DialogTitle>
      <p className="text-sm">
        <Trans
          i18nKey="deleteDialog.description"
          ns="tokens"
          values={{ name: apiToken.name }}
          components={{ strong: <span className="font-medium" /> }}
        />
      </p>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("deleteDialog.cancel")}
        </Button>
        <Button variant="destructive" onClick={() => onConfirm(apiToken.id)}>
          {t("deleteDialog.confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// --- Token Result Dialog ---

function CopyField({
  label,
  value,
  display,
  multiline = false,
  masked = false,
}: {
  label: string;
  value: string;
  display?: string;
  multiline?: boolean;
  masked?: boolean;
}) {
  const { t } = useTranslation("tokens");
  const [copied, setCopied] = useState(false);
  const [visible, setVisible] = useState(!masked);

  function handleCopy() {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const autoMask = `${value.slice(0, 7)}${"•".repeat(32)}`;
  const shown = masked && !visible ? (display ?? autoMask) : value;

  return (
    <div>
      {label && (
        <p className="text-xs font-medium text-gray-500 mb-1">{label}</p>
      )}
      <div className="flex gap-0">
        {multiline ? (
          <pre className="flex-1 min-w-0 bg-gray-50 border border-r-0 border-gray-200 rounded-l-md px-3 py-2 font-mono text-xs text-gray-800 whitespace-pre-wrap break-all overflow-auto max-h-28">
            {shown}
          </pre>
        ) : (
          <code className="flex-1 min-w-0 bg-gray-50 border border-r-0 border-gray-200 rounded-l-md px-3 py-2 font-mono text-xs text-gray-800 overflow-x-auto flex items-center whitespace-nowrap">
            {shown}
          </code>
        )}
        {masked && (
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className="shrink-0 px-2 border-y border-gray-200 bg-white hover:bg-gray-50 transition-colors flex items-center justify-center"
            title={visible ? t("result.hide") : t("result.show")}
          >
            {visible ? (
              <EyeOff className="w-4 h-4 text-gray-500" />
            ) : (
              <Eye className="w-4 h-4 text-gray-500" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className={`shrink-0 px-3 border border-gray-200 bg-white hover:bg-gray-50 transition-colors flex items-center justify-center ${masked ? "rounded-r-md border-l-0" : "rounded-r-md"}`}
          title={t("card.copy")}
        >
          {copied ? (
            <span className="text-green-600 text-xs font-medium">
              {t("card.copied")}!
            </span>
          ) : (
            <Copy className="w-4 h-4 text-gray-500" />
          )}
        </button>
      </div>
    </div>
  );
}

function QRCodeDisplay({ payload }: { payload: string }) {
  const { t } = useTranslation("tokens");
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import("qrcode").then((mod) => {
      const QRCode = mod.default ?? mod;
      QRCode.toString(payload, {
        type: "svg",
        margin: 4,
        errorCorrectionLevel: "H",
        color: { dark: "#000000", light: "#ffffff" },
      }).then((svg: string) => {
        if (cancelled) return;
        const encoded = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
        setDataUrl(encoded);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative">
        <div className="relative w-64 h-64 bg-white border-2 border-gray-300 rounded-md flex items-center justify-center shadow-sm">
          {dataUrl && (
            <img
              src={dataUrl}
              alt="WebDAV QR"
              className={`w-full h-full transition-all ${visible ? "" : "blur-lg"}`}
            />
          )}
          {dataUrl && visible && (
            <img
              src="/brand/monogram-64.png"
              alt=""
              aria-hidden
              className="absolute w-10 h-10 rounded-md bg-white p-1 shadow-sm ring-1 ring-gray-200"
            />
          )}
        </div>
        {!visible && (
          <button
            type="button"
            onClick={() => setVisible(true)}
            className="absolute inset-0 flex items-center justify-center"
          >
            <span className="px-3 py-1.5 bg-white border border-gray-300 rounded shadow-sm text-xs font-medium text-gray-700">
              {t("result.webdavQrShow")}
            </span>
          </button>
        )}
      </div>
      {visible && (
        <button
          type="button"
          onClick={() => setVisible(false)}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-600 hover:text-gray-900"
        >
          <EyeOff className="w-3 h-3" />
          {t("result.webdavQrHide")}
        </button>
      )}
      <p className="text-xs text-gray-500 text-center max-w-xs">
        {t("result.webdavQrNote")}
      </p>
    </div>
  );
}

export function TokenResultDialog({
  result,
  onClose,
  appUrl,
}: {
  result: TokenResult | null;
  onClose: () => void;
  appUrl?: string;
}) {
  const { t } = useTranslation("tokens");
  const [activeTab, setActiveTab] = useState<"agent" | "rest" | "webdav">(
    "agent",
  );

  if (!result) return null;

  const origin =
    typeof window !== "undefined" ? window.location.origin : (appUrl ?? "");
  const maskedToken = `${result.token.slice(0, 7)}${"•".repeat(32)}`;
  const agentIntro = `S2 file storage API. Read the docs, then use the token below to make requests.\nYou can list, read, and write the user's files.\n\nDocs: ${origin}/llms.txt`;
  const agentText = `${agentIntro}\nToken: ${result.token}`;
  const agentTextMasked = `${agentIntro}\nToken: ${maskedToken}`;
  const curlText = `curl -H "Authorization: Bearer ${result.token}" ${origin}/api/v1/token`;
  const curlTextMasked = `curl -H "Authorization: Bearer ${maskedToken}" ${origin}/api/v1/token`;
  const webdavUrl = `${origin}/dav`;
  const webdavQrPayload = JSON.stringify({
    type: "webdav",
    url: webdavUrl,
    username: "s2",
    password: result.token,
  });

  return (
    <Dialog open={!!result} onOpenChange={onClose} size="lg">
      <DialogTitle>{t("result.title")}</DialogTitle>
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 mb-4">
        <p className="text-sm font-medium text-amber-800">
          {t("result.warning")}
        </p>
      </div>

      <div className="space-y-4">
        {/* Step 1: Token */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            ① {t("result.tokenLabel")}
          </p>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
            <CopyField label="" value={result.token} masked />
            <p className="text-xs text-gray-400">
              {t("result.expires", {
                date: formatDate(new Date(result.expires_at)),
              })}
            </p>
          </div>
        </div>

        {/* Step 2: Usage */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            ② {t("result.quickStart")}
          </p>
          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <div className="flex border-b border-gray-200 bg-gray-50">
              <button
                type="button"
                onClick={() => setActiveTab("agent")}
                className={`px-4 py-2 text-xs font-medium transition-colors ${
                  activeTab === "agent"
                    ? "bg-white border-b-2 border-blue-500 text-blue-600"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {t("result.agentLabel")}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("rest")}
                className={`px-4 py-2 text-xs font-medium transition-colors ${
                  activeTab === "rest"
                    ? "bg-white border-b-2 border-blue-500 text-blue-600"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {t("result.restLabel")}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("webdav")}
                className={`px-4 py-2 text-xs font-medium transition-colors ${
                  activeTab === "webdav"
                    ? "bg-white border-b-2 border-blue-500 text-blue-600"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {t("result.webdavLabel")}
              </button>
            </div>
            <div className="p-3">
              {activeTab === "agent" && (
                <div className="space-y-1">
                  <p className="text-xs text-gray-400">
                    {t("result.agentNote")}
                  </p>
                  <CopyField
                    label=""
                    value={agentText}
                    display={agentTextMasked}
                    multiline
                    masked
                  />
                </div>
              )}
              {activeTab === "rest" && (
                <CopyField
                  label=""
                  value={curlText}
                  display={curlTextMasked}
                  masked
                />
              )}
              {activeTab === "webdav" && (
                <div className="space-y-3">
                  <QRCodeDisplay payload={webdavQrPayload} />
                  <div className="pt-1 border-t border-gray-100" />
                  <CopyField
                    label={t("result.webdavUrlLabel")}
                    value={webdavUrl}
                  />
                  <CopyField
                    label={t("result.webdavUsernameLabel")}
                    value="s2"
                  />
                  <CopyField
                    label={t("result.webdavPasswordLabel")}
                    value={result.token}
                    masked
                  />
                  <a
                    href="/docs/webdav"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block text-xs text-blue-500 hover:text-blue-700 hover:underline"
                  >
                    {t("result.webdavSetupLink")}
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4">
        <a
          href="/docs"
          className="inline-block text-xs text-blue-500 hover:text-blue-700 hover:underline"
        >
          {t("result.fullDocs")}
        </a>
      </div>

      <DialogFooter>
        <Button onClick={onClose}>{t("result.done")}</Button>
      </DialogFooter>
    </Dialog>
  );
}
