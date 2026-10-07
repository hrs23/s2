import {
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Download,
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  ImageIcon,
  Pencil,
  Settings,
  Table,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TokenBadge } from "~/components/token-badge";
import type { InternalApiToken as ApiToken } from "~/lib/api";
import { resolveAccess } from "~/lib/auth/scope";
import type { TreeEntry } from "~/lib/files/tree";
import { cn } from "~/lib/utils/cn";
import { formatBytes } from "~/lib/utils/format";
import { type SortBy, type SortOrder, sortEntries } from "./file-utils";

function FileIcon({
  name,
  className = "w-4 h-4",
}: {
  name: string;
  className?: string;
}) {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();

  if ([".md", ".txt"].includes(ext)) return <FileText className={className} />;
  if (ext === ".json") return <FileJson className={className} />;
  if (ext === ".csv") return <Table className={className} />;
  if ([".yaml", ".yml", ".toml", ".conf", ".cfg", ".env"].includes(ext))
    return <Settings className={className} />;
  if (
    [
      ".js",
      ".ts",
      ".py",
      ".go",
      ".rs",
      ".sh",
      ".html",
      ".css",
      ".sql",
    ].includes(ext)
  )
    return <FileCode className={className} />;
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext))
    return <ImageIcon className={className} />;
  return <File className={className} />;
}

function SortIcon({ active, order }: { active: boolean; order: SortOrder }) {
  if (!active) return <ChevronsUpDown className="w-3 h-3 text-gray-400" />;
  return order === "asc" ? (
    <ChevronUp className="w-3 h-3 text-gray-600" />
  ) : (
    <ChevronDown className="w-3 h-3 text-gray-600" />
  );
}

export function buildBreadcrumbs(prefix: string, rootLabel = "My Files") {
  const segments = prefix.split("/").filter(Boolean);
  const crumbs = [{ label: rootLabel, prefix: "" }];
  for (let i = 0; i < segments.length; i++) {
    crumbs.push({
      label: segments[i],
      prefix: `${segments.slice(0, i + 1).join("/")}/`,
    });
  }
  return crumbs;
}

export function Breadcrumb({
  prefix,
  onNavigate,
}: {
  prefix: string;
  onNavigate: (prefix: string) => void;
}) {
  const { t } = useTranslation("files");
  const crumbs = buildBreadcrumbs(prefix, t("breadcrumbRoot"));
  return (
    <nav className="flex items-center gap-1.5 text-sm text-gray-500 mb-4">
      {crumbs.map((c, i) => (
        <span key={c.prefix} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-gray-300">/</span>}
          <button
            type="button"
            onClick={() => onNavigate(c.prefix)}
            className={
              i === crumbs.length - 1
                ? "font-medium text-gray-900"
                : "hover:text-gray-900 transition-colors"
            }
          >
            {c.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

const MAX_VISIBLE_BADGES = 2;

function TokenBadges({
  filePath,
  tokens,
}: {
  filePath: string;
  tokens: ApiToken[];
}) {
  const matching = tokens.filter((tk) => {
    const level = resolveAccess(tk.base_path, tk.access_paths, filePath);
    return level !== null;
  });
  if (matching.length === 0) return null;

  const visible = matching.slice(0, MAX_VISIBLE_BADGES);
  const rest = matching.length - MAX_VISIBLE_BADGES;

  return (
    <span className="inline-flex gap-1">
      {visible.map((tk) => (
        <TokenBadge key={tk.id} id={tk.id} name={tk.name} />
      ))}
      {rest > 0 && (
        <span className="relative group/more">
          <span className="inline-block bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight cursor-default">
            +{rest}
          </span>
          <span className="absolute top-full left-0 hidden group-hover/more:block pt-1 z-20">
            <span className="flex flex-col gap-1 bg-white border border-gray-200 rounded-md shadow-lg p-1.5 whitespace-nowrap">
              {matching.slice(MAX_VISIBLE_BADGES).map((tk) => (
                <TokenBadge key={tk.id} id={tk.id} name={tk.name} />
              ))}
            </span>
          </span>
        </span>
      )}
    </span>
  );
}

const SORT_COLUMNS = ["name", "size", "date"] as const;
const SORT_COLUMN_KEYS: Record<string, string> = {
  name: "columns.name",
  size: "columns.size",
  date: "columns.date",
};

export function FileTree({
  entries,
  onNavigate,
  onView,
  onDelete,
  deletingKey,
  onDeleteConfirm,
  onDeleteCancel,
  onRename,
  onMove,
  tokens = [],
  prefix = "",
}: {
  entries: TreeEntry[];
  onNavigate: (folder: string) => void;
  onView: (entry: TreeEntry) => void;
  onDelete: (key: string) => void;
  deletingKey: string | null;
  onDeleteConfirm: (key: string) => void;
  onDeleteCancel: () => void;
  onRename: (entry: TreeEntry) => void;
  onMove: (entry: TreeEntry) => void;
  tokens?: ApiToken[];
  prefix?: string;
}) {
  const { t } = useTranslation("files");
  const [sortBy, setSortBy] = useState<SortBy>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");

  function handleSortClick(col: SortBy) {
    if (sortBy === col) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortOrder("asc");
    }
  }

  const sorted = sortEntries(entries, sortBy, sortOrder);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-400">
        <FolderOpen className="w-12 h-12 mb-3 opacity-50" />
        <p className="text-sm">{t("empty.title")}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      {/* Mobile sort bar */}
      <div className="md:hidden flex items-center gap-2 px-4 py-2 border-b border-gray-200 bg-gray-50 text-xs text-gray-500 select-none">
        <span className="text-gray-400">{t("sort")}</span>
        {SORT_COLUMNS.map((col) => (
          <button
            key={col}
            type="button"
            className={cn(
              "flex items-center gap-0.5 px-2 py-1 rounded transition-colors",
              sortBy === col
                ? "bg-gray-200 text-gray-700"
                : "hover:text-gray-700",
            )}
            onClick={() => handleSortClick(col)}
          >
            {t(SORT_COLUMN_KEYS[col])}
            <SortIcon active={sortBy === col} order={sortOrder} />
          </button>
        ))}
      </div>
      {/* Desktop column headers */}
      <div className="hidden md:flex items-center gap-3 px-4 py-2 border-b border-gray-200 bg-gray-50 text-xs text-gray-500 select-none">
        <span className="w-4 h-4 shrink-0" />
        <button
          type="button"
          className="flex-1 flex items-center gap-1 text-left hover:text-gray-700 transition-colors"
          onClick={() => handleSortClick("name")}
        >
          {t("columns.name")}
          <SortIcon active={sortBy === "name"} order={sortOrder} />
        </button>
        <button
          type="button"
          className="hidden lg:flex w-20 items-center justify-end gap-1 hover:text-gray-700 transition-colors"
          onClick={() => handleSortClick("size")}
        >
          {t("columns.size")}
          <SortIcon active={sortBy === "size"} order={sortOrder} />
        </button>
        <button
          type="button"
          className="w-28 flex items-center justify-end gap-1 hover:text-gray-700 transition-colors"
          onClick={() => handleSortClick("date")}
        >
          {t("columns.date")}
          <SortIcon active={sortBy === "date"} order={sortOrder} />
        </button>
        {tokens.length > 0 && (
          <span className="hidden xl:inline-block w-36 text-right">
            {t("columns.access")}
          </span>
        )}
        <span className="w-32" />
      </div>

      {/* Rows */}
      <div className="divide-y divide-gray-100">
        {sorted.map((entry) => {
          const isDeleting = deletingKey === entry.fullKey;
          return (
            <div
              key={entry.name}
              className="group px-4 py-2.5 hover:bg-gray-50 transition-colors"
            >
              {/* Desktop: single row */}
              <div className="hidden md:flex items-center gap-3">
                {/* Icon */}
                <span className="w-4 h-4 shrink-0 flex items-center justify-center">
                  {entry.type === "folder" ? (
                    <Folder className="w-4 h-4 text-blue-400 fill-blue-100" />
                  ) : (
                    <FileIcon
                      name={entry.name}
                      className="w-4 h-4 text-gray-400"
                    />
                  )}
                </span>

                {/* Name */}
                <span className="flex-1 text-sm min-w-0">
                  {entry.type === "folder" ? (
                    <button
                      type="button"
                      onClick={() => onNavigate(entry.name)}
                      className="font-medium text-blue-600 hover:underline truncate max-w-full text-left"
                    >
                      {entry.name}/
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onView(entry)}
                      className="font-mono hover:text-blue-600 hover:underline text-left truncate max-w-full"
                    >
                      {entry.name}
                    </button>
                  )}
                </span>

                {/* Size \u2014 lg+ only (narrow widths drop this first to keep name visible) */}
                <span className="hidden lg:inline-block w-20 text-xs text-gray-400 text-right shrink-0">
                  {entry.type === "file"
                    ? formatBytes(entry.size ?? 0)
                    : "\u2014"}
                </span>

                {/* Date */}
                <span className="w-28 text-xs text-gray-400 text-right shrink-0">
                  {entry.type === "file" && entry.modified_at
                    ? new Date(entry.modified_at).toLocaleDateString("en-US")
                    : "\u2014"}
                </span>

                {/* Tokens \u2014 xl+ only */}
                {tokens.length > 0 && (
                  <span className="hidden xl:flex w-36 shrink-0 justify-end">
                    <TokenBadges
                      filePath={
                        "/" +
                        (entry.type === "folder"
                          ? `${prefix + entry.name}/`
                          : (entry.fullKey ?? ""))
                      }
                      tokens={tokens}
                    />
                  </span>
                )}

                {/* Actions */}
                <span className="w-32 shrink-0 flex items-center justify-end gap-1">
                  {!isDeleting && (
                    <>
                      {entry.type === "file" && (
                        <a
                          href={`/api/v1/files/${entry.fullKey}`}
                          download={entry.name}
                          title={t("actions.download")}
                          className="opacity-0 group-hover:opacity-100 inline-flex items-center justify-center rounded-md p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                      )}
                      <button
                        type="button"
                        title={t("actions.move")}
                        className="opacity-0 group-hover:opacity-100 inline-flex items-center justify-center rounded-md p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all"
                        onClick={() => onMove(entry)}
                      >
                        <FolderInput className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        title={t("actions.rename")}
                        className="opacity-0 group-hover:opacity-100 inline-flex items-center justify-center rounded-md p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all"
                        onClick={() => onRename(entry)}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        title={t("actions.delete")}
                        className="opacity-0 group-hover:opacity-100 inline-flex items-center justify-center rounded-md p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 transition-all"
                        // biome-ignore lint/style/noNonNullAssertion: fullKey is always set for entries
                        onClick={() => onDelete(entry.fullKey!)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                  {isDeleting && (
                    <>
                      <button
                        type="button"
                        title={t("actions.delete")}
                        className="inline-flex items-center justify-center rounded-md p-1.5 text-white bg-red-500 hover:bg-red-600 transition-colors"
                        // biome-ignore lint/style/noNonNullAssertion: fullKey is always set for entries
                        onClick={() => onDeleteConfirm(entry.fullKey!)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        title={t("actions.cancel")}
                        className="inline-flex items-center justify-center rounded-md p-1.5 text-gray-500 hover:bg-gray-100 transition-colors"
                        onClick={onDeleteCancel}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </span>
              </div>

              {/* Mobile: two-row layout */}
              <div className="md:hidden">
                <div className="flex items-center gap-3">
                  {/* Icon */}
                  <span className="w-4 h-4 shrink-0 flex items-center justify-center">
                    {entry.type === "folder" ? (
                      <Folder className="w-4 h-4 text-blue-400 fill-blue-100" />
                    ) : (
                      <FileIcon
                        name={entry.name}
                        className="w-4 h-4 text-gray-400"
                      />
                    )}
                  </span>

                  {/* Name */}
                  <span className="flex-1 text-sm min-w-0">
                    {entry.type === "folder" ? (
                      <button
                        type="button"
                        onClick={() => onNavigate(entry.name)}
                        className="font-medium text-blue-600 hover:underline truncate max-w-full text-left"
                      >
                        {entry.name}/
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onView(entry)}
                        className="font-mono hover:text-blue-600 hover:underline text-left truncate max-w-full"
                      >
                        {entry.name}
                      </button>
                    )}
                  </span>

                  {/* Actions — always visible on mobile */}
                  <span className="shrink-0 flex items-center gap-1">
                    {!isDeleting && (
                      <>
                        {entry.type === "file" && (
                          <a
                            href={`/api/v1/files/${entry.fullKey}`}
                            download={entry.name}
                            title={t("actions.download")}
                            className="inline-flex items-center justify-center rounded-md p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Download className="w-3.5 h-3.5" />
                          </a>
                        )}
                        <button
                          type="button"
                          title={t("actions.move")}
                          className="inline-flex items-center justify-center rounded-md p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all"
                          onClick={() => onMove(entry)}
                        >
                          <FolderInput className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title={t("actions.rename")}
                          className="inline-flex items-center justify-center rounded-md p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all"
                          onClick={() => onRename(entry)}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title={t("actions.delete")}
                          className="inline-flex items-center justify-center rounded-md p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 transition-all"
                          // biome-ignore lint/style/noNonNullAssertion: fullKey is always set for entries
                          onClick={() => onDelete(entry.fullKey!)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                    {isDeleting && (
                      <>
                        <button
                          type="button"
                          title={t("actions.delete")}
                          className="inline-flex items-center justify-center rounded-md p-1.5 text-white bg-red-500 hover:bg-red-600 transition-colors"
                          // biome-ignore lint/style/noNonNullAssertion: fullKey is always set for entries
                          onClick={() => onDeleteConfirm(entry.fullKey!)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title={t("actions.cancel")}
                          className="inline-flex items-center justify-center rounded-md p-1.5 text-gray-500 hover:bg-gray-100 transition-colors"
                          onClick={onDeleteCancel}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </span>
                </div>
                {/* Second row: size */}
                {entry.type === "file" && (
                  <div className="pl-7 text-xs text-gray-400 mt-0.5">
                    {formatBytes(entry.size ?? 0)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
