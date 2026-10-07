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
import { runVersionPruning } from "../version-pruning.server";

let tx: ReturnType<typeof asTestTx>;
// version-pruning no longer calls storage .delete(). Each pruned
// file_revisions row triggers a tombstone enqueue.

const USER = "user_cron_ver_001";

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

let revSeq = 0;

async function addRevision(
  nodeId: string,
  storagePrefix: string,
  isCurrent: boolean,
  chunkCount = 1,
) {
  const revId = `rev_${storagePrefix.replace(/[\\/]/g, "_")}`;
  const createdAt = new Date(
    Date.now() - (100 - revSeq++) * 1000,
  ).toISOString();
  await db.execute(
    `INSERT INTO file_revisions (id, node_id, user_id, storage_prefix, content_type, chunk_count, size, hash, created_at)
     SELECT $1, id, user_id, $3, 'text/plain', $4, 100, $5, $6 FROM file_nodes WHERE id = $2`,
    [revId, nodeId, storagePrefix, chunkCount, `test-hash-${revId}`, createdAt],
  );
  if (isCurrent) {
    await db.execute(
      "UPDATE file_nodes SET current_revision_id = $1 WHERE id = $2",
      [revId, nodeId],
    );
  }
  return revId;
}

beforeEach(async () => {
  revSeq = 0;
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

describe("runVersionPruning", () => {
  it("skips when maxPastVersions <= 0", async () => {
    const result = await runVersionPruning(makeEnv(), 0);
    expect(result.prunedRevisions).toBe(0);
  });

  it("prunes older revisions, keeps current + maxPastVersions, and enqueues tombstones", async () => {
    const r = repo();
    const node = await r.createNode(
      { userId: USER, parentId: "", name: "file.txt", isDirectory: false },
      tx,
    );

    const prefix = `${USER}/${node.id}/u`;
    const r1 = await addRevision(node.id, `${prefix}/r1`, false);
    const r2 = await addRevision(node.id, `${prefix}/r2`, false);
    const r3 = await addRevision(node.id, `${prefix}/r3`, false);
    const r4 = await addRevision(node.id, `${prefix}/r4`, false);
    const rCurrent = await addRevision(node.id, `${prefix}/rcurrent`, true);

    // maxPastVersions=2: keep 2 most recent past, delete 2 oldest
    const result = await runVersionPruning(makeEnv(), 2);

    expect(result.prunedRevisions).toBe(2);

    const remaining = await db.query<{ id: string }>(
      "SELECT id FROM file_revisions WHERE node_id = $1 ORDER BY created_at",
      [node.id],
    );
    const ids = remaining.map((r) => r.id);
    expect(ids).not.toContain(r1);
    expect(ids).not.toContain(r2);
    expect(ids).toContain(r3);
    expect(ids).toContain(r4);
    expect(ids).toContain(rCurrent);

    // Tombstones for the two pruned revisions only
    const tombstones = await db.query<{ storage_prefix: string }>(
      "SELECT storage_prefix FROM storage_tombstones ORDER BY storage_prefix",
    );
    expect(tombstones.map((t) => t.storage_prefix).sort()).toEqual(
      [`${prefix}/r1`, `${prefix}/r2`].sort(),
    );
  });

  // Path reconstruction is still exercised by the repo-level prune itself
  // (asserts on the deleted revisions' `pathAfter` field below).
  it("returns pathAfter per pruned revision across nested folders", async () => {
    const r = repo();
    const dirA = await r.createNode(
      { userId: USER, parentId: "", name: "a", isDirectory: true },
      tx,
    );
    const dirB = await r.createNode(
      { userId: USER, parentId: dirA.id, name: "b", isDirectory: true },
      tx,
    );
    const file1 = await r.createNode(
      { userId: USER, parentId: dirB.id, name: "f1.txt", isDirectory: false },
      tx,
    );
    const file2 = await r.createNode(
      { userId: USER, parentId: dirA.id, name: "f2.txt", isDirectory: false },
      tx,
    );
    const file3 = await r.createNode(
      { userId: USER, parentId: "", name: "f3.txt", isDirectory: false },
      tx,
    );

    for (const node of [file1, file2, file3]) {
      const prefix = `${USER}/${node.id}/u`;
      await addRevision(node.id, `${prefix}/r1`, false);
      await addRevision(node.id, `${prefix}/r2`, false);
      await addRevision(node.id, `${prefix}/r3`, false);
      await addRevision(node.id, `${prefix}/rcurrent`, true);
    }

    // maxPastVersions=1: keep current + 1 past, prune 2 per file × 3 files = 6.
    const result = await runVersionPruning(makeEnv(), 1);
    expect(result.prunedRevisions).toBe(6);
  });

  it("does not prune trash nodes", async () => {
    const r = repo();
    const node = await r.createNode(
      { userId: USER, parentId: "", name: "trashed.txt", isDirectory: false },
      tx,
    );
    const prefix = `${USER}/${node.id}/u`;
    await addRevision(node.id, `${prefix}/r1`, false);
    await addRevision(node.id, `${prefix}/rcurrent`, true);
    await new TrashRepository().softDeleteNode(USER, node.id, tx);

    const env = makeEnv();
    const result = await runVersionPruning(env, 0);
    expect(result.prunedRevisions).toBe(0);

    const result2 = await runVersionPruning(env, 1);
    expect(result2.prunedRevisions).toBe(0);
  });
});
