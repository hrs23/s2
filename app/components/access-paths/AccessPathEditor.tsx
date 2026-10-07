import { ChevronLeft, ChevronRight, File, Folder } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { type AccessPath, api } from "~/lib/api";
import { parseTree, type TreeEntry } from "~/lib/files/tree";

export type { AccessPath };

function newAccessPath(): AccessPath {
  return { path: "", access: "write" };
}

/** State (canonical: basePath-relative) → input display.
 *  Display === state under the new contract. Kept as a function so calling
 *  sites stay parametric in case the rendering ever needs decoration. */
function pathToDisplay(path: string): string {
  return path;
}

/** Input → state. Strips a stray leading "/" the user might paste in (they
 *  often think in absolute terms); other normalization runs server-side. */
function displayToPath(display: string): string {
  return display.replace(/^\/+/, "");
}

/** Base path → prefix label shown immutably to the left of the input.
 *  "/" → "/", "/photos" → "/photos/", "/photos/" → "/photos/". */
function basePathLabel(basePath: string): string {
  if (basePath === "/") return "/";
  return basePath.endsWith("/") ? basePath : `${basePath}/`;
}

function PathBrowserDropdown({
  prefix,
  basePrefix = "",
  onNavigate,
  onSelect,
  onClose,
}: {
  prefix: string;
  basePrefix?: string;
  onNavigate: (prefix: string) => void;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("access-paths");
  const [items, setItems] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  const fetchItems = useCallback(async (p: string) => {
    setLoading(true);
    try {
      const { items: fileItems } = await api.files.list(p);
      setItems(parseTree(fileItems, p));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems(prefix);
  }, [prefix, fetchItems]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute left-0 right-0 top-full mt-1 z-10 border border-gray-200 rounded-md shadow-lg bg-white max-h-60 overflow-y-auto"
    >
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-100 text-xs text-gray-500 font-mono">
        {prefix !== basePrefix && (
          <button
            type="button"
            className="hover:text-gray-700 p-0.5 shrink-0"
            onClick={() => {
              const parent = prefix.replace(/[^/]+\/$/, "");
              onNavigate(
                parent.length >= basePrefix.length ? parent : basePrefix,
              );
            }}
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
        )}
        <span className="truncate">/{prefix}</span>
      </div>

      {loading && (
        <p className="px-3 py-4 text-sm text-gray-400 text-center">
          {t("pathBrowser.loading")}
        </p>
      )}

      {!loading && items.length === 0 && (
        <p className="px-3 py-4 text-sm text-gray-400 text-center">
          {t("pathBrowser.empty")}
        </p>
      )}

      {!loading &&
        items.map((entry) => (
          <div key={entry.name} className="flex items-center hover:bg-gray-50">
            <button
              type="button"
              className="flex-1 flex items-center gap-2 px-3 py-1.5 text-sm text-left"
              onClick={() =>
                onSelect(
                  prefix + entry.name + (entry.type === "folder" ? "/" : ""),
                )
              }
            >
              {entry.type === "folder" ? (
                <Folder className="w-4 h-4 text-blue-400 shrink-0" />
              ) : (
                <File className="w-4 h-4 text-gray-400 shrink-0" />
              )}
              <span className="text-gray-700">{entry.name}</span>
            </button>
            {entry.type === "folder" && (
              <button
                type="button"
                className="px-2 py-1.5 text-gray-300 hover:text-gray-600"
                onClick={() => onNavigate(`${prefix + entry.name}/`)}
                aria-label={`Open ${entry.name}`}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
    </div>
  );
}

export function PathInputWithBrowse({
  value,
  onChange,
  placeholder = "/",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const { t } = useTranslation("access-paths");
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browsePrefix, setBrowsePrefix] = useState("");

  return (
    <div className="relative">
      <div className="flex items-center gap-0">
        <Input
          className="flex-1 text-sm rounded-r-none font-mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={(e) => {
            const el = e.target;
            requestAnimationFrame(() =>
              el.setSelectionRange(el.value.length, el.value.length),
            );
          }}
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={() => {
            if (browseOpen) {
              setBrowseOpen(false);
            } else {
              setBrowsePrefix("");
              setBrowseOpen(true);
            }
          }}
          className={`inline-flex items-center justify-center h-9 px-2 border border-l-0 border-gray-300 rounded-r-md transition-colors ${
            browseOpen
              ? "bg-gray-100 text-gray-700"
              : "text-gray-400 hover:text-gray-600 hover:bg-gray-50"
          }`}
          aria-label={t("editor.browseAria")}
        >
          <Folder className="w-4 h-4" />
        </button>
      </div>
      {browseOpen && (
        <PathBrowserDropdown
          prefix={browsePrefix}
          onNavigate={setBrowsePrefix}
          onSelect={(selected) => {
            onChange(`/${selected.replace(/\/$/, "")}` || "/");
            setBrowseOpen(false);
          }}
          onClose={() => setBrowseOpen(false)}
        />
      )}
    </div>
  );
}

export function AccessPathEditor({
  accessPaths,
  onChange,
  basePath = "/",
  allowEmpty = true,
}: {
  accessPaths: AccessPath[];
  onChange: (accessPaths: AccessPath[]) => void;
  basePath?: string;
  /**
   * When true, an empty list renders the "All paths accessible" hint with
   * a button to start adding rows. When false, callers must ensure at least
   * one row exists (used by OAuth consent where a scope is required).
   */
  allowEmpty?: boolean;
}) {
  const { t } = useTranslation("access-paths");
  const [browseIndex, setBrowseIndex] = useState<number | null>(null);
  const [browsePrefix, setBrowsePrefix] = useState("");

  function update(index: number, patch: Partial<AccessPath>) {
    onChange(accessPaths.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  function addRow() {
    onChange([...accessPaths, newAccessPath()]);
  }

  function removeRow(index: number) {
    onChange(accessPaths.filter((_, i) => i !== index));
  }

  const basePrefix =
    basePath === "/" ? "" : basePath.replace(/^\//, "").replace(/\/?$/, "/");

  function openBrowse(index: number) {
    setBrowseIndex(index);
    setBrowsePrefix(basePrefix);
  }

  if (allowEmpty && accessPaths.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-gray-500">{t("editor.allPaths")}</p>
        <Button type="button" size="sm" variant="outline" onClick={addRow}>
          {t("editor.limitPaths")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {accessPaths.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: access_paths have no unique ID; index is the stable key
        <div key={i} className="relative">
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-stretch gap-0">
              <span className="inline-flex items-center px-2 text-sm text-gray-400 bg-gray-50 border border-r-0 border-gray-300 rounded-l-md font-mono whitespace-nowrap select-none">
                {basePathLabel(basePath)}
              </span>
              <Input
                className="flex-1 text-sm rounded-none font-mono"
                value={pathToDisplay(p.path)}
                onChange={(e) =>
                  update(i, { path: displayToPath(e.target.value) })
                }
                onFocus={(e) => {
                  const el = e.target;
                  requestAnimationFrame(() =>
                    el.setSelectionRange(el.value.length, el.value.length),
                  );
                }}
                placeholder={t("editor.pathPlaceholder")}
                aria-label={`Path ${i + 1}`}
              />
              <button
                type="button"
                onClick={() =>
                  browseIndex === i ? setBrowseIndex(null) : openBrowse(i)
                }
                className={`inline-flex items-center justify-center h-9 px-2 border border-l-0 border-gray-300 rounded-r-md transition-colors ${
                  browseIndex === i
                    ? "bg-gray-100 text-gray-700"
                    : "text-gray-400 hover:text-gray-600 hover:bg-gray-50"
                }`}
                aria-label={t("editor.browseAria")}
              >
                <Folder className="w-4 h-4" />
              </button>
            </div>
            <select
              className="text-sm border border-gray-300 rounded-md px-2 py-1"
              value={p.access}
              onChange={(e) =>
                update(i, { access: e.target.value as "read" | "write" })
              }
            >
              <option value="write">{t("access.write")}</option>
              <option value="read">{t("access.read")}</option>
            </select>
            {(allowEmpty || accessPaths.length > 1) && (
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="text-gray-400 hover:text-red-500 text-lg leading-none"
                aria-label={t("editor.removeAria")}
              >
                ×
              </button>
            )}
          </div>
          {browseIndex === i && (
            <PathBrowserDropdown
              prefix={browsePrefix}
              basePrefix={basePrefix}
              onNavigate={setBrowsePrefix}
              onSelect={(selectedPrefix) => {
                const relative = selectedPrefix.startsWith(basePrefix)
                  ? selectedPrefix.slice(basePrefix.length)
                  : selectedPrefix;
                const trimmed = relative.replace(/\/$/, "");
                update(i, { path: trimmed === "" ? "/" : `/${trimmed}` });
                setBrowseIndex(null);
              }}
              onClose={() => setBrowseIndex(null)}
            />
          )}
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={addRow}>
        {t("editor.addPath")}
      </Button>
    </div>
  );
}
