import type { SecondaryStorage } from "better-auth";

interface Entry {
  readonly value: string;
  readonly expiresAt: number | null;
}

const SWEEP_INTERVAL_MS = 60_000;

export function createMemorySecondaryStorage(): SecondaryStorage {
  const store = new Map<string, Entry>();

  function getLiveEntry(key: string): Entry | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        store.delete(key);
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  return {
    async get(key) {
      return getLiveEntry(key)?.value ?? null;
    },
    async set(key, value, ttl) {
      store.set(key, {
        value,
        expiresAt:
          typeof ttl === "number" && ttl > 0 ? Date.now() + ttl * 1000 : null,
      });
    },
    async delete(key) {
      store.delete(key);
    },
  };
}
