import type { ListItem, StorageAdapter, StorageObject } from "./adapter";
import { validateStorageKey, validateStoragePrefix } from "./adapter";

interface Entry {
  data: Uint8Array;
}

export class MemoryStorageAdapter implements StorageAdapter {
  private store = new Map<string, Entry>();

  async availableBytes(): Promise<number | null> {
    return null;
  }

  async get(key: string): Promise<StorageObject | null> {
    validateStorageKey(key);
    const entry = this.store.get(key);
    if (!entry) return null;
    const data = entry.data;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
    return {
      body,
    };
  }

  async head(key: string) {
    validateStorageKey(key);
    const entry = this.store.get(key);
    if (!entry) return null;
    return { size: entry.data.byteLength };
  }

  async put(key: string, body: ArrayBuffer): Promise<void> {
    validateStorageKey(key);
    const data = new Uint8Array(body).slice();
    this.store.set(key, {
      data,
    });
  }

  async delete(key: string) {
    validateStorageKey(key);
    this.store.delete(key);
  }

  async deleteMany(keys: string[]) {
    for (const key of keys) this.store.delete(key);
  }

  async list(prefix: string): Promise<ListItem[]> {
    validateStoragePrefix(prefix);
    const items: ListItem[] = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        items.push({ key });
      }
    }
    return items.sort((a, b) => a.key.localeCompare(b.key));
  }

  // For testing: reset the store
  clear() {
    this.store.clear();
  }
}
