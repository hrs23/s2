import { File, Folder, RotateCcw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/button";
import { api } from "~/lib/api";
import { cn } from "~/lib/utils/cn";
import { formatBytes } from "~/lib/utils/format";
import { daysUntilPurge } from "./file-utils";

export interface TrashItem {
  id: string;
  name: string;
  type: "file" | "directory";
  size: number;
  deleted_at: string | null;
}

export function TrashTab({
  items,
  onRevalidate,
}: {
  items: TrashItem[];
  onRevalidate: () => void;
}) {
  const { t } = useTranslation("trash");
  const [restoring, setRestoring] = useState<Set<string>>(new Set());
  const [purging, setPurging] = useState<Set<string>>(new Set());
  const [purgingAll, setPurgingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRestore(id: string) {
    setError(null);
    setRestoring((prev) => new Set(prev).add(id));
    try {
      await api.internal.trash.restore(id);
      onRevalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function handlePurge(item: TrashItem) {
    if (!window.confirm(t("confirmPurge", { name: item.name }))) return;
    setError(null);
    setPurging((prev) => new Set(prev).add(item.id));
    try {
      await api.internal.trash.purge(item.id);
      onRevalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPurging((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  }

  async function handlePurgeAll() {
    if (!window.confirm(t("confirmPurgeAll"))) return;
    setError(null);
    setPurgingAll(true);
    try {
      await api.internal.trash.purgeAll();
      onRevalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPurgingAll(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-end mb-4">
        {items.length > 0 && (
          <Button
            variant="destructive"
            size="sm"
            disabled={purgingAll}
            onClick={handlePurgeAll}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {purgingAll ? t("purgingAll") : t("purgeAll")}
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <Trash2 className="w-10 h-10 mx-auto mb-2 opacity-40" />
          <p>{t("empty")}</p>
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">{t("columns.name")}</th>
                <th className="px-4 py-2 font-medium hidden sm:table-cell">
                  {t("columns.size")}
                </th>
                <th className="px-4 py-2 font-medium hidden sm:table-cell">
                  {t("columns.purgeIn")}
                </th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((item) => {
                const days = daysUntilPurge(item.deleted_at);
                const isRestoring = restoring.has(item.id);
                const isPurging = purging.has(item.id);
                const isBusy = isRestoring || isPurging || purgingAll;
                return (
                  <tr
                    key={item.id}
                    className="hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-4 py-2.5 flex items-center gap-2">
                      {item.type === "directory" ? (
                        <Folder className="w-4 h-4 text-gray-400 shrink-0" />
                      ) : (
                        <File className="w-4 h-4 text-gray-400 shrink-0" />
                      )}
                      <span className="truncate">{item.name}</span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 hidden sm:table-cell">
                      {item.type === "file" ? formatBytes(item.size) : "-"}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-2.5 hidden sm:table-cell",
                        days !== null && days <= 7
                          ? "text-red-500"
                          : "text-gray-500",
                      )}
                    >
                      {days !== null
                        ? t("daysRemaining", { count: days })
                        : "-"}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isBusy}
                          onClick={() => handleRestore(item.id)}
                        >
                          <RotateCcw
                            className={cn(
                              "w-3.5 h-3.5",
                              isRestoring && "animate-spin",
                            )}
                          />
                          <span className="hidden sm:inline">
                            {isRestoring ? t("restoring") : t("restore")}
                          </span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isBusy}
                          onClick={() => handlePurge(item)}
                          className="text-red-500 hover:text-red-700 hover:bg-red-50"
                        >
                          <X className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">
                            {isPurging ? t("purging") : t("purge")}
                          </span>
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
