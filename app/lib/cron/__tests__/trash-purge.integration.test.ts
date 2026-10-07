import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "~/lib/db/client.server";
import { FileNodeRepository } from "~/lib/files/file-node-repository.server";
import { TrashRepository } from "~/lib/files/trash-repository.server";
import {
  asTestTx,
  FINITE_TEST_LIMITS,
  seedTestUser,
} from "~/test/integration-helpers";
import { createTestDb } from "~/test/test-db";
import { runTrashPurge } from "../trash-purge.server";

let tx: ReturnType<typeof asTestTx>;
// trash-purge no longer calls storage .delete(). Each file_revisions
// CASCADE delete fires the storage_tombstones trigger; storage-gc reaps blobs
// later. Tests verify both the DB-side bookkeeping and that the trigger
// produced one tombstone per affected revision.

const USER = "user_cron_trash_001";

let db: DbClient;

beforeAll(async () => {
  db = await createTestDb();

  tx = asTestTx(db);
});

function makeEnv(): Env {
  return {
    DATABASE_URL: "postgres://stub:stub@stub:5432/stub",
    __testDbClient: db,
  } as unknown as Env;
}

function repo(): FileNodeRepository {
  return new FileNodeRepository();
}

async function addRevision(
  nodeId: string,
  storagePrefix: string,
  chunkCount = 1,
  size = 100,
) {
  const revId = `rev_${storagePrefix.replace(/\//g, "_")}`;
  await db.execute(
    `INSERT INTO file_revisions (id, node_id, user_id, storage_prefix, content_type, chunk_count, size, hash)
     SELECT $1, id, user_id, $3, 'text/plain', $4, $5, $6 FROM file_nodes WHERE id = $2`,
    [revId, nodeId, storagePrefix, chunkCount, size, `test-hash-${revId}`],
  );
  await db.execute(
    `UPDATE file_nodes SET current_revision_id = $1, cached_size = $2 WHERE id = $3`,
    [revId, size, nodeId],
  );
  return revId;
}

beforeEach(async () => {
  await db.execute("DELETE FROM storage_tombstones");
  await db.execute("DELETE FROM file_nodes");
  await db.execute(`DELETE FROM "user"`);
  await seedTestUser(db, {
    id: USER,
    email: `${USER}@test.local`,
    limits: FINITE_TEST_LIMITS,
    bytesUsed: 0,
  });
});

describe("runTrashPurge", () => {
  it("does nothing when trash is empty", async () => {
    const result = await runTrashPurge(makeEnv(), 30);
    expect(result.purgedNodes).toBe(0);
  });

  it("does not purge nodes trashed within retention period", async () => {
    const r = repo();
    const tr = new TrashRepository();
    const node = await r.createNode(
      { userId: USER, parentId: "", name: "recent.txt", isDirectory: false },
      tx,
    );
    await tr.softDeleteNode(USER, node.id, tx);

    const result = await runTrashPurge(makeEnv(), 30);
    expect(result.purgedNodes).toBe(0);

    const tombstones = await db.query("SELECT 1 FROM storage_tombstones");
    expect(tombstones).toHaveLength(0);
  });

  it("purges expired nodes, enqueues tombstones, and updates bytes_used", async () => {
    const r = repo();
    const node = await r.createNode(
      { userId: USER, parentId: "", name: "old.txt", isDirectory: false },
      tx,
    );
    const prefix = `${USER}/${node.id}/u/attempt1`;
    await addRevision(node.id, prefix, 2, 500);

    const thirtyOneDaysAgo = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await db.execute("UPDATE file_nodes SET deleted_at = $1 WHERE id = $2", [
      thirtyOneDaysAgo,
      node.id,
    ]);
    await db.execute(
      "UPDATE user_storage SET bytes_used = 500 WHERE user_id = $1",
      [USER],
    );

    const result = await runTrashPurge(makeEnv(), 30);
    expect(result.purgedNodes).toBe(1);

    // Node gone
    const remaining = await db.query(
      "SELECT id FROM file_nodes WHERE id = $1",
      [node.id],
    );
    expect(remaining).toHaveLength(0);

    // bytes_used decremented
    const user = await db.queryOne<{ bytes_used: number }>(
      "SELECT bytes_used FROM user_storage WHERE user_id = $1",
      [USER],
    );
    expect(user?.bytes_used).toBe(0);

    // Tombstone enqueued by the file_revisions DELETE trigger
    const tombstones = await db.query<{ storage_prefix: string }>(
      "SELECT storage_prefix FROM storage_tombstones",
    );
    expect(tombstones.map((t) => t.storage_prefix)).toEqual([prefix]);
  });

  it("enqueues one tombstone per affected revision when purging multiple files", async () => {
    const r = repo();
    const nodeA = await r.createNode(
      { userId: USER, parentId: "", name: "a.txt", isDirectory: false },
      tx,
    );
    const prefixA = `${USER}/${nodeA.id}/u/a1`;
    await addRevision(nodeA.id, prefixA, 1, 100);
    const nodeB = await r.createNode(
      { userId: USER, parentId: "", name: "b.txt", isDirectory: false },
      tx,
    );
    const prefixB = `${USER}/${nodeB.id}/u/b1`;
    await addRevision(nodeB.id, prefixB, 1, 100);

    const thirtyOneDaysAgo = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await db.execute(
      "UPDATE file_nodes SET deleted_at = $1 WHERE id = ANY($2)",
      [thirtyOneDaysAgo, [nodeA.id, nodeB.id]],
    );
    await db.execute(
      "UPDATE user_storage SET bytes_used = 200 WHERE user_id = $1",
      [USER],
    );

    const result = await runTrashPurge(makeEnv(), 30);
    expect(result.purgedNodes).toBe(2);

    const tombstones = await db.query<{ storage_prefix: string }>(
      "SELECT storage_prefix FROM storage_tombstones ORDER BY storage_prefix",
    );
    expect(tombstones.map((t) => t.storage_prefix).sort()).toEqual(
      [prefixA, prefixB].sort(),
    );
  });
});
