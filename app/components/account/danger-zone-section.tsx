import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";

export function DangerZoneSection() {
  const { t } = useTranslation("settings");
  const [showDialog, setShowDialog] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/internal/account/delete", { method: "POST" });
      if (res.ok) {
        window.location.href = "/login";
        return;
      }
      const data = (await res.json()) as { error?: { message?: string } };
      setError(data?.error?.message ?? t("danger.failedToDelete"));
    } catch {
      setError(t("danger.unexpectedError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <section className="bg-white rounded-lg border border-red-200 p-6">
        <button
          type="button"
          onClick={() => setShowDialog(true)}
          className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors"
        >
          {t("danger.deleteAccount")}
        </button>
      </section>

      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              {t("danger.deleteDialog.title")}
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              {t("danger.deleteDialog.description")}
            </p>
            <label className="block text-sm text-gray-700 mb-2">
              <Trans
                i18nKey="danger.deleteDialog.typeConfirm"
                ns="settings"
                components={{
                  strong: <span className="font-mono font-semibold" />,
                }}
              />
            </label>
            <input
              type="text"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:ring-1 focus:ring-red-500 outline-none"
              placeholder={t("danger.deleteDialog.placeholder")}
              autoComplete="off"
            />
            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowDialog(false);
                  setConfirmation("");
                  setError(null);
                }}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                {t("danger.deleteDialog.cancel")}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={confirmation !== "DELETE" || submitting}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting
                  ? t("danger.deleteDialog.deleting")
                  : t("danger.deleteDialog.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
