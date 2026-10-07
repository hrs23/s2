import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import type { ListItem, StorageAdapter, StorageObject } from "./adapter";
import { validateStorageKey, validateStoragePrefix } from "./adapter";

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

function isIgnorableRmdirError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
      (err as { code?: string }).code ?? "",
    )
  );
}

function assertInsideRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Storage path escapes root");
  }
}

function streamFrom(data: Uint8Array): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

export class FileSystemStorageAdapter implements StorageAdapter {
  private readonly root: string;
  private readonly tmpDir: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
    this.tmpDir = path.join(this.root, ".tmp");
  }

  private pathForKey(key: string): string {
    const target = path.resolve(this.root, ...validateStorageKey(key));
    assertInsideRoot(this.root, target);
    return target;
  }

  private pathForPrefix(prefix: string): string {
    const target = path.resolve(this.root, ...validateStoragePrefix(prefix));
    assertInsideRoot(this.root, target);
    return target;
  }

  async availableBytes() {
    const info = await statfs(this.root);
    return info.bavail * info.bsize;
  }

  async get(key: string): Promise<StorageObject | null> {
    try {
      const data = await readFile(this.pathForKey(key));
      return { body: streamFrom(data) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async head(key: string) {
    try {
      const info = await stat(this.pathForKey(key));
      if (!info.isFile()) return null;
      return { size: info.size };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async put(key: string, body: ArrayBuffer): Promise<void> {
    const target = this.pathForKey(key);
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });

    const tmpPath = path.join(this.tmpDir, randomUUID());
    assertInsideRoot(this.root, tmpPath);

    try {
      const handle = await open(tmpPath, "w", 0o600);
      try {
        await handle.writeFile(new Uint8Array(body));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmpPath, target);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.pathForKey(key);
    try {
      await unlink(target);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      return;
    }
    await this.pruneEmptyParents(path.dirname(target));
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.delete(key);
    }
  }

  async list(prefix: string): Promise<ListItem[]> {
    const dir = this.pathForPrefix(prefix);
    const items: ListItem[] = [];
    try {
      await this.walk(dir, prefix, items);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    return items.sort((a, b) => a.key.localeCompare(b.key));
  }

  private async walk(
    dir: string,
    keyPrefix: string,
    items: ListItem[],
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      assertInsideRoot(this.root, fullPath);
      if (entry.isDirectory()) {
        await this.walk(fullPath, `${keyPrefix}${entry.name}/`, items);
        continue;
      }
      if (!entry.isFile()) continue;

      items.push({ key: `${keyPrefix}${entry.name}` });
    }
  }

  private async pruneEmptyParents(startDir: string): Promise<void> {
    let current = startDir;
    while (current !== this.root && current !== this.tmpDir) {
      assertInsideRoot(this.root, current);
      try {
        await rmdir(current);
      } catch (err) {
        if (isIgnorableRmdirError(err)) return;
        throw err;
      }
      current = path.dirname(current);
    }
  }
}
