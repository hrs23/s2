import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useRevalidator, useSearchParams } from "react-router";
import {
  MoveDialog,
  MultiUploadProgressBar,
  NewFolderDialog,
  NewTextFileDialog,
  RenameDialog,
  UploadFileDialog,
  ViewFileDialog,
} from "~/components/files/file-dialogs";
import { Breadcrumb, FileTree } from "~/components/files/file-tree";
import { type TrashItem, TrashTab } from "~/components/files/trash-tab";
import { Button } from "~/components/ui/button";
import { api } from "~/lib/api";
import {
  type FileUploadEntry,
  type MultiUploadState,
  uploadFile,
} from "~/lib/files/chunked-upload";
import { readDroppedItems } from "~/lib/files/dnd";
import { parseTree, type TreeEntry } from "~/lib/files/tree";
import { cn } from "~/lib/utils/cn";
import type { Route } from "./+types/_dashboard.files";

export function meta() {
  return [{ title: "My Files | S2" }];
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const url = new URL(request.url);
  const prefix = url.searchParams.get("prefix") ?? "";
  const tab = url.searchParams.get("tab");

  const [files, tokenData] = await Promise.all([
    api.files.list(prefix),
    api.internal.tokens.list(),
  ]);

  let trashItems: TrashItem[] = [];
  if (tab === "trash") {
    const data = await api.internal.trash.list();
    trashItems = data.items;
  }

  return { ...files, tokens: tokenData.tokens, trashItems };
}

export function HydrateFallback() {
  const { t } = useTranslation("files");
  return <p className="text-gray-500">{t("loading")}</p>;
}

// --- Container ---

export default function FilesPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("files");
  const { items, tokens, trashItems } = loaderData;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const prefix = searchParams.get("prefix") ?? "";
  const tab = searchParams.get("tab") ?? "files";

  const [newTextOpen, setNewTextOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [viewingEntry, setViewingEntry] = useState<TreeEntry | null>(null);
  const [renamingEntry, setRenamingEntry] = useState<TreeEntry | null>(null);
  const [movingEntry, setMovingEntry] = useState<TreeEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [multiUpload, setMultiUpload] = useState<MultiUploadState | null>(null);
  const uploadingRef = useRef(false);
  const dragCounter = useRef(0);

  const entries = parseTree(items, prefix);

  useEffect(() => {
    document.title = t("meta.title");
  }, [t]);

  function navigateToFolder(folderName: string) {
    navigate(`/files?prefix=${encodeURIComponent(`${prefix + folderName}/`)}`);
  }

  function navigateTo(p: string) {
    if (p === "") navigate("/files");
    else navigate(`/files?prefix=${encodeURIComponent(p)}`);
  }

  function reload() {
    revalidate();
  }

  async function handleNewText(path: string, content: string) {
    try {
      const body = new TextEncoder().encode(content).buffer as ArrayBuffer;
      await api.files.upload(path, body);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    }
  }

  async function uploadMany(items: { relativePath: string; file: File }[]) {
    if (items.length === 0) return;
    if (uploadingRef.current) return;

    const entries: FileUploadEntry[] = items.map(({ relativePath, file }) => ({
      name: relativePath,
      status: "pending" as const,
      loaded: 0,
      total: file.size,
    }));
    setMultiUpload({ files: entries, currentIndex: 0 });
    uploadingRef.current = true;

    for (let i = 0; i < items.length; i++) {
      const { relativePath, file } = items[i];
      entries[i] = { ...entries[i], status: "uploading" };
      setMultiUpload({ files: [...entries], currentIndex: i });
      try {
        await uploadFile(prefix + relativePath, file, (p) => {
          entries[i] = {
            ...entries[i],
            status: "uploading",
            loaded: p.loaded,
            total: p.total,
          };
          setMultiUpload({ files: [...entries], currentIndex: i });
        });
        entries[i] = { ...entries[i], status: "done", loaded: file.size };
        setMultiUpload({ files: [...entries], currentIndex: i });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "failed";
        entries[i] = { ...entries[i], status: "failed", error: msg };
        setMultiUpload({ files: [...entries], currentIndex: i });
      }
    }

    const failed = entries.filter((e) => e.status === "failed");
    if (failed.length) {
      setError(failed.map((f) => `${f.name}: ${f.error}`).join(" / "));
    }
    setMultiUpload(null);
    uploadingRef.current = false;
    reload();
  }

  async function handleUpload(files: File[]) {
    await uploadMany(files.map((file) => ({ relativePath: file.name, file })));
  }

  async function handleNewFolder(folderPath: string) {
    try {
      const body = new ArrayBuffer(0);
      await api.files.upload(folderPath, body);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    }
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current++;
    setDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    if (uploadingRef.current) return; // ignore drops while uploading
    const items = await readDroppedItems(e.dataTransfer);
    await uploadMany(items);
  }

  function handleDelete(key: string) {
    setDeletingKey(key);
  }

  async function handleDeleteConfirm(key: string) {
    setDeletingKey(null);
    try {
      await api.files.delete(key);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("error"));
    }
  }

  function handleDeleteCancel() {
    setDeletingKey(null);
  }

  function handleRenameStart(entry: TreeEntry) {
    setDeletingKey(null);
    setRenamingEntry(entry);
  }

  function handleMoveStart(entry: TreeEntry) {
    setDeletingKey(null);
    setMovingEntry(entry);
  }

  async function handleMoveSubmit(entry: TreeEntry, destPath: string) {
    if (!entry.fullKey) return;
    const source = entry.fullKey.replace(/\/$/, "");
    await api.files.move(source, destPath);
    reload();
  }

  // Rename is modeled as a same-parent move on the server. We split the
  // source fullKey into (parent prefix, old name) and join (parent prefix,
  // new name) for the destination. Folders have a trailing slash on
  // fullKey which parseClientPath() strips server-side, so we don't have
  // to special-case them here.
  async function handleRenameSubmit(entry: TreeEntry, newName: string) {
    if (!entry.fullKey) return;
    const source = entry.fullKey.replace(/\/$/, "");
    const parentPrefix = source.slice(0, source.length - entry.name.length);
    const destination =
      entry.type === "folder"
        ? `${parentPrefix}${newName}/`
        : `${parentPrefix}${newName}`;
    await api.files.move(source, destination);
    reload();
  }

  return (
    <div>
      <div className="flex gap-4 border-b border-gray-200 mb-6">
        <button
          type="button"
          className={cn(
            "pb-2 text-sm font-medium border-b-2 -mb-px transition-colors",
            tab === "files"
              ? "border-gray-900 text-gray-900"
              : "border-transparent text-gray-500 hover:text-gray-700",
          )}
          onClick={() => navigate("/files")}
        >
          {t("tabs.files")}
        </button>
        <button
          type="button"
          className={cn(
            "pb-2 text-sm font-medium border-b-2 -mb-px transition-colors",
            tab === "trash"
              ? "border-gray-900 text-gray-900"
              : "border-transparent text-gray-500 hover:text-gray-700",
          )}
          onClick={() => navigate("/files?tab=trash")}
        >
          {t("tabs.trash")}
        </button>
      </div>

      {tab === "trash" ? (
        <TrashTab items={trashItems} onRevalidate={revalidate} />
      ) : (
        <div
          className="relative"
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {dragging && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-400 bg-blue-50/80">
              <p className="text-lg font-medium text-blue-600">
                {t("dropHere")}
              </p>
            </div>
          )}
          {multiUpload && !uploadOpen && (
            <div className="mb-4">
              <MultiUploadProgressBar state={multiUpload} />
            </div>
          )}
          {prefix && <Breadcrumb prefix={prefix} onNavigate={navigateTo} />}
          <div className="flex items-center justify-end mb-4">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFolderOpen(true)}
              >
                {t("buttons.folder")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setNewTextOpen(true)}
              >
                {t("buttons.text")}
              </Button>
              <Button size="sm" onClick={() => setUploadOpen(true)}>
                {t("buttons.upload")}
              </Button>
            </div>
          </div>

          <p className="text-xs text-gray-400 mb-3">
            {t("items", { count: entries.length })}
          </p>

          {error && (
            <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => setError(null)}
              >
                {t("actions.dismiss")}
              </button>
            </div>
          )}

          <FileTree
            entries={entries}
            onNavigate={navigateToFolder}
            onView={setViewingEntry}
            onDelete={handleDelete}
            deletingKey={deletingKey}
            onDeleteConfirm={handleDeleteConfirm}
            onDeleteCancel={handleDeleteCancel}
            onRename={handleRenameStart}
            onMove={handleMoveStart}
            tokens={tokens}
            prefix={prefix}
          />

          <ViewFileDialog
            entry={viewingEntry}
            onClose={() => setViewingEntry(null)}
            onSaved={reload}
          />

          <NewFolderDialog
            open={folderOpen}
            onOpenChange={setFolderOpen}
            defaultPrefix={prefix}
            onSubmit={handleNewFolder}
          />

          <RenameDialog
            entry={renamingEntry}
            onOpenChange={(open) => {
              if (!open) setRenamingEntry(null);
            }}
            onSubmit={handleRenameSubmit}
          />

          <MoveDialog
            entry={movingEntry}
            onOpenChange={(open) => {
              if (!open) setMovingEntry(null);
            }}
            onSubmit={handleMoveSubmit}
          />

          <NewTextFileDialog
            open={newTextOpen}
            onOpenChange={setNewTextOpen}
            prefix={prefix}
            onSubmit={handleNewText}
          />

          <UploadFileDialog
            open={uploadOpen}
            onOpenChange={setUploadOpen}
            onSubmit={handleUpload}
            multiUpload={multiUpload}
          />
        </div>
      )}
    </div>
  );
}
