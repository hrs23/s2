import type { TreeEntry } from "~/lib/files/tree";

// --- Types ---

export type SortBy = "name" | "size" | "date";
export type SortOrder = "asc" | "desc";

/**
 * Preview categories. Decided in adr/preview-scope.md.
 * "none" means show metadata + download only — no in-browser viewer.
 */
export type PreviewType =
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "markdown"
  | "code"
  | "none";

// --- Constants ---

// Code / text-like extensions. Rendered with syntax highlighting (Shiki).
// HTML is intentionally here (source view only — never rendered, see ADR).
const CODE_EXTS = new Set([
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".log",
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".vue",
  ".svelte",
  ".sh",
  ".conf",
  ".cfg",
  ".env",
  ".toml",
  ".xml",
  ".html",
  ".htm",
  ".svg",
  ".css",
  ".sql",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".lua",
  ".lock",
  ".dockerfile",
  ".gitignore",
]);

const MARKDOWN_EXTS = new Set([".md", ".markdown"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const VIDEO_EXTS = new Set([".mp4", ".webm"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a"]);
const PDF_EXTS = new Set([".pdf"]);

const TRASH_RETENTION_DAYS = 30;

// Size limits per category (bytes). Beyond this we hide the viewer and only
// offer download — the viewer would lock up the browser otherwise.
export const PREVIEW_SIZE_LIMITS: Record<PreviewType, number | null> = {
  code: 8 * 1024 * 1024,
  markdown: 8 * 1024 * 1024,
  image: 100 * 1024 * 1024,
  pdf: null,
  video: null,
  audio: null,
  none: null,
};

// --- Functions ---

function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "";
  return name.slice(dot).toLowerCase();
}

export function getPreviewType(name: string): PreviewType {
  const ext = getExt(name);
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (PDF_EXTS.has(ext)) return "pdf";
  if (CODE_EXTS.has(ext)) return "code";
  return "none";
}

/** True for any text-rendered preview (code or markdown source edit). */
export function isTextFile(name: string): boolean {
  const t = getPreviewType(name);
  return t === "code" || t === "markdown";
}

/** Returns the limit (bytes) it exceeded, or null if within. */
export function exceedsPreviewLimit(
  name: string,
  size: number | null | undefined,
): number | null {
  if (size == null) return null;
  const limit = PREVIEW_SIZE_LIMITS[getPreviewType(name)];
  if (limit != null && size > limit) return limit;
  return null;
}

export function daysUntilPurge(deletedAt: string | null): number | null {
  if (!deletedAt) return null;
  const deleted = new Date(deletedAt).getTime();
  const purgeAt = deleted + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const remaining = Math.ceil((purgeAt - Date.now()) / (24 * 60 * 60 * 1000));
  return Math.max(0, remaining);
}

export function sortEntries(
  entries: TreeEntry[],
  sortBy: SortBy,
  sortOrder: SortOrder,
): TreeEntry[] {
  const folders = entries.filter((e) => e.type === "folder");
  const files = entries.filter((e) => e.type === "file");

  const sorted = [...files].sort((a, b) => {
    let cmp = 0;
    if (sortBy === "name") {
      cmp = a.name.localeCompare(b.name);
    } else if (sortBy === "size") {
      cmp = (a.size ?? 0) - (b.size ?? 0);
    } else if (sortBy === "date") {
      const da = a.modified_at ? new Date(a.modified_at).getTime() : 0;
      const db = b.modified_at ? new Date(b.modified_at).getTime() : 0;
      cmp = da - db;
    }
    return sortOrder === "asc" ? cmp : -cmp;
  });

  return [...folders, ...sorted];
}
