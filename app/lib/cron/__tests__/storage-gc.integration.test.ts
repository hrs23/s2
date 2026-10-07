import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "~/lib/db/client.server";
import type { StorageAdapter } from "~/lib/storage/adapter";
import { MemoryStorageAdapter } from "~/lib/storage/memory.server";
import { createTestDb } from "~/test/test-db";
import { runStorageGc } from "../storage-gc.server";

let db: DbClient;

beforeAll(async () => {
  db = await createTestDb();
});

class TrackingStorageAdapter implements StorageAdapter {
  readonly keys = new Set<string>();

  constructor(
    private readonly inner: MemoryStorageAdapter,
    private readonly failOnPrefix: string[] = [],
  ) {}

  availableBytes() {
    return this.inner.availableBytes();
  }

  async get(key: string) {
    return this.inner.get(key);
  }

  async head(key: string) {
    return this.inner.head(key);
  }

  async put(key: string, body: ArrayBuffer) {
    this.keys.add(key);
    await this.inner.put(key, body);
  }

  async delete(key: string) {
    if (this.failOnPrefix.some((prefix) => key.startsWith(prefix))) {
      throw new Error("simulated storage outage");
    }
    this.keys.delete(key);
    await this.inner.delete(key);
  }

  async deleteMany(keys: string[]) {
    for (const key of keys) {
      await this.delete(key);
    }
  }

  async list(prefix: string) {
    return this.inner.list(prefix);
  }
}

function makeEnv(storage: StorageAdapter): Env {
  return {
    DATABASE_URL: "postgres://stub:stub@stub:5432/stub",
    AUTH_STORAGE: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    __testDbClient: db,
    __storageAdapter: storage,
  } as unknown as Env;
}

async function seedStorage(
  storage: TrackingStorageAdapter,
  keys: string[],
): Promise<void> {
  for (const key of keys) {
    await storage.put(key, new ArrayBuffer(8));
  }
}

async function insertTombstone(
  prefix: string,
  ageDays: number,
): Promise<string> {
  const id = `tombstone_${prefix.replace(/\//g, "_")}_${ageDays}`;
  const createdAt = new Date(
    Date.now() - ageDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  await db.execute(
    "INSERT INTO storage_tombstones (id, storage_prefix, created_at) VALUES ($1, $2, $3)",
    [id, prefix, createdAt],
  );
  return id;
}

beforeEach(async () => {
  await db.execute("DELETE FROM storage_tombstones");
});

describe("runStorageGc", () => {
  it("processes tombstones older than the grace window and deletes their chunks", async () => {
    const prefix = "user1/node1/u/attempt1";
    const storage = new TrackingStorageAdapter(new MemoryStorageAdapter());
    await seedStorage(storage, [`${prefix}/c/00000`, `${prefix}/c/00001`]);
    await insertTombstone(prefix, 10);

    const result = await runStorageGc(makeEnv(storage), 8, 100, storage);

    expect(result.scannedTombstones).toBe(1);
    expect(result.deletedTombstones).toBe(1);
    expect(result.deletedChunks).toBe(2);
    expect(storage.keys.has(`${prefix}/c/00000`)).toBe(false);
    expect(storage.keys.has(`${prefix}/c/00001`)).toBe(false);

    const remaining = await db.query("SELECT 1 FROM storage_tombstones");
    expect(remaining).toHaveLength(0);
  });

  it("skips tombstones still inside the grace window", async () => {
    const prefix = "user1/node2/u/attempt1";
    const storage = new TrackingStorageAdapter(new MemoryStorageAdapter());
    await seedStorage(storage, [`${prefix}/c/00000`]);
    await insertTombstone(prefix, 3);

    const result = await runStorageGc(makeEnv(storage), 8, 100, storage);

    expect(result.scannedTombstones).toBe(0);
    expect(result.deletedTombstones).toBe(0);
    expect(storage.keys.has(`${prefix}/c/00000`)).toBe(true);

    const remaining = await db.query("SELECT id FROM storage_tombstones");
    expect(remaining).toHaveLength(1);
  });

  it("treats a missing prefix (already gone) as success and removes the tombstone", async () => {
    const prefix = "user1/node3/u/attempt1";
    const storage = new TrackingStorageAdapter(new MemoryStorageAdapter());
    await insertTombstone(prefix, 10);

    const result = await runStorageGc(makeEnv(storage), 8, 100, storage);
    expect(result.scannedTombstones).toBe(1);
    expect(result.deletedTombstones).toBe(1);
    expect(result.deletedChunks).toBe(0);

    const remaining = await db.query("SELECT 1 FROM storage_tombstones");
    expect(remaining).toHaveLength(0);
  });

  it("skips non-chunk keys under the same prefix as defence in depth", async () => {
    const prefix = "user1/node4/u/attempt1";
    const storage = new TrackingStorageAdapter(new MemoryStorageAdapter());
    await seedStorage(storage, [
      `${prefix}/c/00000`,
      `${prefix}/something_else`,
    ]);
    await insertTombstone(prefix, 10);

    const result = await runStorageGc(makeEnv(storage), 8, 100, storage);
    expect(result.deletedChunks).toBe(1);
    expect(storage.keys.has(`${prefix}/c/00000`)).toBe(false);
    expect(storage.keys.has(`${prefix}/something_else`)).toBe(true);
  });

  it("continues processing the batch when one tombstone delete throws", async () => {
    const prefixA = "user1/nodeA/u/attempt1";
    const prefixB = "user1/nodeB/u/attempt1";
    const storage = new TrackingStorageAdapter(new MemoryStorageAdapter(), [
      prefixA,
    ]);
    await seedStorage(storage, [`${prefixA}/c/00000`, `${prefixB}/c/00000`]);
    await insertTombstone(prefixA, 10);
    await insertTombstone(prefixB, 10);

    const result = await runStorageGc(makeEnv(storage), 8, 100, storage);

    expect(result.scannedTombstones).toBe(2);
    expect(result.deletedTombstones).toBe(1);

    const remaining = await db.query<{ storage_prefix: string }>(
      "SELECT storage_prefix FROM storage_tombstones",
    );
    expect(remaining.map((r) => r.storage_prefix)).toEqual([prefixA]);
    expect(storage.keys.has(`${prefixA}/c/00000`)).toBe(true);
    expect(storage.keys.has(`${prefixB}/c/00000`)).toBe(false);
  });

  it("respects the batch size", async () => {
    const storage = new TrackingStorageAdapter(new MemoryStorageAdapter());
    for (let i = 0; i < 5; i++) {
      const prefix = `user1/node${i}/u/attempt1`;
      await seedStorage(storage, [`${prefix}/c/00000`]);
      await insertTombstone(prefix, 10 + i);
    }

    const result = await runStorageGc(makeEnv(storage), 8, 2, storage);

    expect(result.scannedTombstones).toBe(2);
    expect(result.deletedTombstones).toBe(2);

    const remaining = await db.query("SELECT 1 FROM storage_tombstones");
    expect(remaining).toHaveLength(3);
  });

  it("returns the lock_skipped=false flag on the happy path", async () => {
    const storage = new TrackingStorageAdapter(new MemoryStorageAdapter());
    const result = await runStorageGc(makeEnv(storage), 8, 100, storage);
    expect(result.lockSkipped).toBe(false);
    expect(result.scannedTombstones).toBe(0);
  });
});
