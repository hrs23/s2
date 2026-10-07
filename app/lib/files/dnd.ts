/**
 * Convert a DataTransfer (from a drop event) into a flat list of files,
 * recursing into any folders. Folder traversal uses the FileSystem API
 * (webkitGetAsEntry); browsers without it fall back to top-level files only.
 */
export interface DroppedFile {
  relativePath: string; // POSIX, no leading slash, e.g. "photos/cat.jpg"
  file: File;
}

export async function readDroppedItems(
  dt: DataTransfer,
): Promise<DroppedFile[]> {
  const items = dt.items;
  const entries: FileSystemEntry[] = [];
  if (items && typeof items[Symbol.iterator] === "function") {
    for (const item of items as unknown as Iterable<DataTransferItem>) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
  } else if (
    items &&
    typeof (items as unknown as { length?: number }).length === "number"
  ) {
    const list = items as unknown as {
      length: number;
      [i: number]: DataTransferItem;
    };
    for (let i = 0; i < list.length; i++) {
      const entry = list[i].webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
  }

  if (entries.length === 0) {
    // Fallback: no FileSystem API access; use the plain files list (folders are not included here).
    return Array.from(dt.files ?? []).map((file) => ({
      relativePath: file.name,
      file,
    }));
  }

  const out: DroppedFile[] = [];
  for (const entry of entries) {
    await walkEntry(entry, "", out);
  }
  return out;
}

async function walkEntry(
  entry: FileSystemEntry,
  parentPath: string,
  out: DroppedFile[],
): Promise<void> {
  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntry);
    const rel = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    out.push({ relativePath: rel, file });
    return;
  }
  if (entry.isDirectory) {
    const dir = entry as FileSystemDirectoryEntry;
    const children = await readAllDirEntries(dir);
    const nextParent = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    for (const child of children) {
      await walkEntry(child, nextParent, out);
    }
  }
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

// readEntries returns batches; spec says you must call it repeatedly until [].
async function readAllDirEntries(
  dir: FileSystemDirectoryEntry,
): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  while (true) {
    const batch: FileSystemEntry[] = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}
