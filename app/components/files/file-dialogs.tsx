import { ChevronDown, Clock, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/button";
import { Dialog, DialogFooter, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ApiError, api } from "~/lib/api";
import type { MultiUploadState } from "~/lib/files/chunked-upload";
import type { TreeEntry } from "~/lib/files/tree";
import { cn } from "~/lib/utils/cn";
import { formatBytes } from "~/lib/utils/format";
import { FilePreview } from "./file-preview";
import { exceedsPreviewLimit, getPreviewType, isTextFile } from "./file-utils";

export function NewTextFileDialog({
  open,
  onOpenChange,
  prefix,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  prefix: string;
  onSubmit: (path: string, content: string) => Promise<void>;
}) {
  const { t } = useTranslation("files");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    const fullPath = (prefix + name.trim()).replace(/^\//, "");
    await onSubmit(fullPath, content);
    setName("");
    setContent("");
    setSubmitting(false);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTitle>{t("newTextFile.title")}</DialogTitle>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            {t("newTextFile.fileName")}
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("newTextFile.fileNamePlaceholder")}
            autoFocus
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            {t("newTextFile.content")}
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={10}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-900"
            placeholder={t("newTextFile.contentPlaceholder")}
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("actions.cancel")}
          </Button>
          <Button type="submit" disabled={submitting || !name.trim()}>
            {submitting ? t("newTextFile.saving") : t("newTextFile.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export function UploadFileDialog({
  open,
  onOpenChange,
  onSubmit,
  multiUpload,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (files: File[]) => Promise<void>;
  multiUpload: MultiUploadState | null;
}) {
  const { t } = useTranslation("files");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0) return;
    setSubmitting(true);
    await onSubmit(files);
    setFiles([]);
    setSubmitting(false);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTitle>{t("uploadFile.title")}</DialogTitle>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <input
            type="file"
            required
            multiple
            className="text-sm"
            onChange={(e) =>
              setFiles(e.target.files ? Array.from(e.target.files) : [])
            }
          />
        </div>
        {submitting && multiUpload && (
          <MultiUploadProgressBar state={multiUpload} />
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("actions.cancel")}
          </Button>
          <Button type="submit" disabled={submitting || files.length === 0}>
            {submitting ? t("uploadFile.uploading") : t("actions.upload")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export function MultiUploadProgressBar({ state }: { state: MultiUploadState }) {
  const { t } = useTranslation("files");
  const { files, currentIndex } = state;
  const done = files.filter((f) => f.status === "done").length;
  const failed = files.filter((f) => f.status === "failed");
  const current = files[currentIndex];

  const totalBytes = files.reduce((s, f) => s + f.total, 0);
  const loadedBytes = files.reduce((s, f) => s + f.loaded, 0);
  const overallPct =
    totalBytes > 0 ? Math.round((loadedBytes / totalBytes) * 100) : 0;

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="flex items-center justify-between text-sm text-gray-700">
        <span>
          {t("uploadProgress.status", {
            current: done + (current?.status === "uploading" ? 1 : 0),
            total: files.length,
          })}
        </span>
        <span className="text-xs text-gray-500">
          {formatBytes(loadedBytes)} / {formatBytes(totalBytes)}
        </span>
      </div>

      {/* Overall progress bar */}
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-gray-900 rounded-full transition-all duration-200"
          style={{ width: `${overallPct}%` }}
        />
      </div>

      {/* Current file */}
      {current && current.status === "uploading" && (
        <div className="text-xs text-gray-500 truncate">
          {current.name}
          {current.total > 0 && current.loaded > 0
            ? ` — ${Math.round((current.loaded / current.total) * 100)}%`
            : ""}
        </div>
      )}

      {/* Failed files */}
      {failed.length > 0 && (
        <div className="space-y-1">
          {failed.map((f) => (
            <div key={f.name} className="text-xs text-red-600 truncate">
              {f.name}: {f.error}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Revision {
  id: string;
  size: number;
  content_type: string;
  hash: string | null;
  created_at: string;
  is_current: boolean;
}

export function ViewFileDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry: TreeEntry | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { t } = useTranslation("files");
  const [content, setContent] = useState<string | null>(null);
  const [editContent, setEditContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  useEffect(() => {
    if (!entry?.fullKey) return;
    setEditing(false);
    setShowVersions(false);
    setRevisions([]);
    setError(null);

    // Only text-based viewers need the content fetched up-front. Image / video
    // / audio / PDF stream from <img>/<video>/<audio>/<iframe> directly.
    if (!isTextFile(entry.name)) {
      setContent(null);
      setLoading(false);
      return;
    }

    // Skip the eager fetch for files we know are too large for the viewer —
    // FilePreview will render a "too large" message instead.
    if (exceedsPreviewLimit(entry.name, entry.size) != null) {
      setContent(null);
      setLoading(false);
      return;
    }

    const ac = new AbortController();
    setLoading(true);
    setContent(null);

    fetch(`/api/v1/files/${encodeURI(entry.fullKey)}`, { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.text();
      })
      .then((text) => {
        setContent(text);
        setEditContent(text);
        setLoading(false);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load");
        setContent(null);
        setLoading(false);
      });

    return () => ac.abort();
  }, [entry?.fullKey, entry?.name, entry?.size]);

  async function loadVersions() {
    if (!entry?.fullKey) return;
    setVersionsLoading(true);
    try {
      const data = await api.internal.revisions.list(entry.fullKey);
      setRevisions(data.revisions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load versions");
    } finally {
      setVersionsLoading(false);
    }
  }

  async function handleToggleVersions() {
    if (showVersions) {
      setShowVersions(false);
      return;
    }
    setShowVersions(true);
    await loadVersions();
  }

  async function handleRestore(revisionId: string) {
    if (!entry?.fullKey) return;
    setRestoringId(revisionId);
    setError(null);
    try {
      await api.internal.revisions.restore(entry.fullKey, revisionId);
      await loadVersions();
      onSaved?.();
    } catch (e) {
      // Version restore is best-effort. If the chosen
      // revision was pruned / over-quota-deleted / explicitly deleted between
      // list and click, the server returns 410 Gone — surface a clearer
      // message than the generic "Failed to restore" so the user knows the
      // list is stale and a reload is needed.
      if (e instanceof ApiError && e.status === 410) {
        setError(t("versions.restoreUnavailable"));
        // Refresh the list so the now-gone revision disappears.
        await loadVersions();
      } else {
        setError(e instanceof Error ? e.message : "Failed to restore");
      }
    } finally {
      setRestoringId(null);
    }
  }

  async function handleSave() {
    if (!entry?.fullKey) return;
    setSaving(true);
    try {
      const body = new TextEncoder().encode(editContent).buffer as ArrayBuffer;
      await api.files.upload(entry.fullKey, body);
      setContent(editContent);
      setEditing(false);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const previewType = entry ? getPreviewType(entry.name) : "none";
  const isEditableText = previewType === "code" || previewType === "markdown";
  const fileUrl = entry?.fullKey
    ? `/api/v1/files/${encodeURI(entry.fullKey)}`
    : "";

  return (
    <Dialog open={!!entry} onOpenChange={onClose}>
      <DialogTitle className="font-mono">{entry?.name}</DialogTitle>
      <div className="min-h-[8rem]">
        {error ? (
          <p className="text-sm text-red-600">
            {t("viewFile.failedToLoad", { error })}
          </p>
        ) : isEditableText && editing ? (
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="w-full text-xs font-mono bg-white rounded p-3 overflow-auto h-[60vh] whitespace-pre border border-gray-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-900 resize-none"
          />
        ) : entry ? (
          <FilePreview
            name={entry.name}
            size={entry.size ?? null}
            url={fileUrl}
            fullKey={entry.fullKey}
            textContent={content}
            loading={loading}
          />
        ) : null}

        {/* Version history */}
        {entry?.id && !editing && (
          <div className="mt-4">
            <button
              type="button"
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
              onClick={handleToggleVersions}
            >
              <Clock className="w-3.5 h-3.5" />
              {t("versions.title")}
              <ChevronDown
                className={cn(
                  "w-3.5 h-3.5 transition-transform",
                  showVersions && "rotate-180",
                )}
              />
            </button>

            {showVersions && (
              <div className="mt-2 border border-gray-200 rounded-lg overflow-hidden">
                {versionsLoading ? (
                  <p className="px-4 py-3 text-sm text-gray-500">
                    {t("viewFile.loading")}
                  </p>
                ) : revisions.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-gray-400">
                    {t("versions.none")}
                  </p>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {revisions.map((rev) => (
                      <div
                        key={rev.id}
                        className="flex items-center justify-between px-4 py-2.5 text-sm"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-gray-700">
                            {new Date(rev.created_at).toLocaleString()}
                          </span>
                          <span className="text-xs text-gray-400">
                            {formatBytes(rev.size)}
                          </span>
                          {rev.is_current && (
                            <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">
                              {t("versions.current")}
                            </span>
                          )}
                        </div>
                        {!rev.is_current && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={restoringId === rev.id}
                            onClick={() => handleRestore(rev.id)}
                          >
                            <RotateCcw
                              className={cn(
                                "w-3.5 h-3.5",
                                restoringId === rev.id && "animate-spin",
                              )}
                            />
                            <span className="hidden sm:inline">
                              {restoringId === rev.id
                                ? t("versions.restoring")
                                : t("versions.restore")}
                            </span>
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <DialogFooter>
        {entry?.fullKey && !editing && (
          <a
            href={`/api/v1/files/${encodeURI(entry.fullKey)}`}
            download={entry.name}
            className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            {t("actions.download")}
          </a>
        )}
        {isEditableText && !editing && content != null && (
          <Button
            variant="outline"
            onClick={() => {
              setEditContent(content);
              setEditing(true);
            }}
          >
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            {t("actions.edit")}
          </Button>
        )}
        {editing && (
          <>
            <Button variant="outline" onClick={() => setEditing(false)}>
              {t("actions.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? t("viewFile.saving") : t("viewFile.save")}
            </Button>
          </>
        )}
        {!editing && <Button onClick={onClose}>{t("actions.close")}</Button>}
      </DialogFooter>
    </Dialog>
  );
}

export function NewFolderDialog({
  open,
  onOpenChange,
  defaultPrefix,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultPrefix: string;
  onSubmit: (path: string) => Promise<void>;
}) {
  const { t } = useTranslation("files");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    const sanitized = name.trim().replace(/\//g, "").replace(/\s+/g, "-");
    await onSubmit(`${defaultPrefix}${sanitized}/`);
    setName("");
    setSubmitting(false);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTitle>{t("newFolder.title")}</DialogTitle>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            {t("newFolder.folderName")}
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("newFolder.folderNamePlaceholder")}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("actions.cancel")}
          </Button>
          <Button type="submit" disabled={submitting || !name.trim()}>
            {submitting ? t("newFolder.creating") : t("newFolder.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export function MoveDialog({
  entry,
  onOpenChange,
  onSubmit,
}: {
  entry: TreeEntry | null;
  onOpenChange: (v: boolean) => void;
  onSubmit: (entry: TreeEntry, destPath: string) => Promise<void>;
}) {
  const { t } = useTranslation("files");
  const [destPath, setDestPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (entry) {
      setDestPath("");
      setError(null);
      setSubmitting(false);
    }
  }, [entry]);

  // Strip leading slash; keep trailing slash if user typed one (it's stripped below)
  const trimmed = destPath.trim().replace(/^\//, "");

  const validationError = (() => {
    if (!trimmed) return null;
    if (trimmed.includes("\0"))
      return t("move.errors.nullByte", "Path cannot contain null bytes");
    if (trimmed.split("/").some((seg) => seg === ".." || seg === "."))
      return t("move.errors.reserved", "Path cannot contain '.' or '..'");
    return null;
  })();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!entry || !trimmed || validationError) return;
    setSubmitting(true);
    setError(null);
    // User specifies the destination *folder*. We append the entry name so
    // that "archive/2025/" moves memo.txt to "archive/2025/memo.txt".
    const destDir = trimmed.replace(/\/$/, "");
    const dest =
      entry.type === "folder"
        ? `${destDir}/${entry.name}/`
        : `${destDir}/${entry.name}`;
    try {
      await onSubmit(entry, dest);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error"));
      setSubmitting(false);
    }
  }

  const title =
    entry?.type === "folder"
      ? t("move.folderTitle", "Move folder")
      : t("move.fileTitle", "Move file");

  return (
    <Dialog open={entry != null} onOpenChange={onOpenChange}>
      <DialogTitle>{title}</DialogTitle>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            {t("move.currentPath", "Current path")}
          </label>
          <p className="text-sm font-mono text-gray-700 truncate">
            {entry?.fullKey ?? ""}
          </p>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            {t("move.destFolder", "Destination folder")}
          </label>
          <Input
            value={destPath}
            onChange={(e) => setDestPath(e.target.value)}
            placeholder={t("move.placeholder", "e.g. archive/2025/")}
            autoFocus
          />
          {validationError && (
            <p className="mt-1 text-xs text-red-600">{validationError}</p>
          )}
          {error && !validationError && (
            <p className="mt-1 text-xs text-red-600">{error}</p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("actions.cancel")}
          </Button>
          <Button
            type="submit"
            disabled={submitting || !trimmed || validationError != null}
          >
            {submitting
              ? t("move.submitting", "Moving…")
              : t("move.submit", "Move")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export function RenameDialog({
  entry,
  onOpenChange,
  onSubmit,
}: {
  // null → dialog closed; non-null → dialog open and rebound to this entry.
  entry: TreeEntry | null;
  onOpenChange: (v: boolean) => void;
  onSubmit: (entry: TreeEntry, newName: string) => Promise<void>;
}) {
  const { t } = useTranslation("files");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the input with the current name every time the dialog is rebound
  // to a new entry. Also clear transient form state (error / submitting).
  // We key on entry identity so the effect only runs on open / target swap,
  // not on every keystroke.
  useEffect(() => {
    if (entry) {
      setName(entry.name);
      setError(null);
      setSubmitting(false);
    }
  }, [entry]);

  const trimmed = name.trim();
  // Disallow "/" (would mean "move into a subdirectory" — use a dedicated
  // move UI for that), null bytes, ".." traversal, and the reserved "." /
  // empty name. These match the server-side validation in
  // validateClientPath(), surfaced client-side so the user gets feedback
  // without a round-trip.
  const validationError = (() => {
    if (!trimmed) return null; // submit is just disabled
    if (trimmed.includes("/"))
      return t("rename.errors.slashNotAllowed", "Name cannot contain '/'");
    if (trimmed.includes("\0"))
      return t("rename.errors.nullByte", "Name cannot contain null bytes");
    if (trimmed === "." || trimmed === "..")
      return t("rename.errors.reserved", "Name cannot be '.' or '..'");
    return null;
  })();
  const unchanged = entry != null && trimmed === entry.name;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!entry || !trimmed || validationError) return;
    if (unchanged) {
      onOpenChange(false);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(entry, trimmed);
      onOpenChange(false);
    } catch (err) {
      // Surface the server error inline so the user can pick a different
      // name without losing the dialog context (e.g. 409 "destination
      // already exists").
      setError(err instanceof Error ? err.message : t("error"));
      setSubmitting(false);
    }
  }

  const title =
    entry?.type === "folder" ? t("rename.folderTitle") : t("rename.fileTitle");

  return (
    <Dialog open={entry != null} onOpenChange={onOpenChange}>
      <DialogTitle>{title}</DialogTitle>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            {t("rename.newName")}
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {validationError && (
            <p className="mt-1 text-xs text-red-600">{validationError}</p>
          )}
          {error && !validationError && (
            <p className="mt-1 text-xs text-red-600">{error}</p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("actions.cancel")}
          </Button>
          <Button
            type="submit"
            disabled={
              submitting || !trimmed || validationError != null || unchanged
            }
          >
            {submitting ? t("rename.submitting") : t("rename.submit")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
