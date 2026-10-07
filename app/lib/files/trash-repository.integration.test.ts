// Cross-user isolation guards for TrashRepository.
//
// Each test seeds two users (A, B), creates trashed state as A, and then
// tries to operate as B. Reads must return null/empty; writes must touch
// 0 rows (no-op).
//
// Functions intentionally not exercised here for cross-user isolation:
//   - reconstructNodePath(userId, nodeId, client)  — private helper
//   - purgeExpiredTrash(userId, maxAge)            — explicit per-user
//                                                    (cron iterates per user)

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "~/lib/db/client.server";
import { FileNodeRepository } from "~/lib/files/file-node-repository.server";
import { TrashRepository } from "~/lib/files/trash-repository.server";
import { asTestTx, seedTestUser } from "~/test/integration-helpers";
import { createTestDb } from "~/test/test-db";

const USER_A = "user_a_trash";
const USER_B = "user_b_trash";

let db: DbClient;
let tx: ReturnType<typeof asTestTx>;

beforeAll(async () => {
  db = await createTestDb();

  tx = asTestTx(db);
});

beforeEach(async () => {
  await db.execute("DELETE FROM file_nodes");
  await seedTestUser(db, { id: USER_A, email: `${USER_A}@test.local` });
  await seedTestUser(db, { id: USER_B, email: `${USER_B}@test.local` });
});

function repo(): FileNodeRepository {
  return new FileNodeRepository();
}
function trashRepo(): TrashRepository {
  return new TrashRepository();
}

async function seedTrashedFile(
  userId: string,
  name: string,
): Promise<{ nodeId: string; revisionId: string }> {
  const r = repo();
  const tr = trashRepo();
  const node = await r.createNode(
    {
      userId,
      parentId: "",
      name,
      isDirectory: false,
      contentType: "text/plain",
    },
    tx,
  );
  const revisionId = `rev_${userId}_${name}`;
  await r.createRevision(
    userId,
    node.id,
    revisionId,
    {
      storagePrefix: `r2/${revisionId}`,
      contentType: "text/plain",
      chunkCount: 1,
      size: 100,
      hash: "h",
    },
    0,
    tx,
  );
  await tr.softDeleteNode(userId, node.id, tx);
  return { nodeId: node.id, revisionId };
}

describe("TrashRepository", () => {
  // softDeleteNode ──────────────────────────────────────────────────────
  it("softDeleteNode: B cannot soft-delete A's live node", async () => {
    const r = repo();
    const tr = trashRepo();
    const node = await r.createNode(
      { userId: USER_A, parentId: "", name: "live.txt", isDirectory: false },
      tx,
    );
    const ok = await tr.softDeleteNode(USER_B, node.id, tx);
    expect(ok).toBe(false);
    // Still live for A
    const alive = await r.getNode(USER_A, node.id, tx);
    expect(alive).not.toBeNull();
    expect(alive?.deletedAt).toBeNull();
  });

  it("softDeleteNode: B cannot soft-delete A's directory subtree", async () => {
    const r = repo();
    const tr = trashRepo();
    const dir = await r.createNode(
      { userId: USER_A, parentId: "", name: "dir", isDirectory: true },
      tx,
    );
    const child = await r.createNode(
      { userId: USER_A, parentId: dir.id, name: "c.txt", isDirectory: false },
      tx,
    );
    const ok = await tr.softDeleteNode(USER_B, dir.id, tx);
    expect(ok).toBe(false);
    expect((await r.getNode(USER_A, dir.id, tx))?.deletedAt).toBeNull();
    expect((await r.getNode(USER_A, child.id, tx))?.deletedAt).toBeNull();
  });

  // restoreNode ─────────────────────────────────────────────────────────
  it("restoreNode: B sees not_found for A's trashed node", async () => {
    const { nodeId } = await seedTrashedFile(USER_A, "trashed.txt");
    const tr = trashRepo();
    expect(await tr.restoreNode(USER_B, nodeId, tx)).toBe("not_found");
    // Still in trash for A
    expect(await tr.getTrashNode(USER_A, nodeId, tx)).not.toBeNull();
  });

  it("restoreNode: A's restore still works (sanity)", async () => {
    const { nodeId } = await seedTrashedFile(USER_A, "trashed.txt");
    const tr = trashRepo();
    expect(await tr.restoreNode(USER_A, nodeId, tx)).toBe("ok");
  });

  // listTrash ───────────────────────────────────────────────────────────
  it("listTrash: B's trash list excludes A's trashed nodes", async () => {
    await seedTrashedFile(USER_A, "a-trash.txt");
    await seedTrashedFile(USER_B, "b-trash.txt");
    const tr = trashRepo();
    const aList = await tr.listTrash(USER_A, tx);
    const bList = await tr.listTrash(USER_B, tx);
    expect(aList.map((n) => n.name)).toEqual(["a-trash.txt"]);
    expect(bList.map((n) => n.name)).toEqual(["b-trash.txt"]);
  });

  it("listTrash: empty for user with no trash even when peer has plenty", async () => {
    await seedTrashedFile(USER_A, "x.txt");
    await seedTrashedFile(USER_A, "y.txt");
    await seedTrashedFile(USER_A, "z.txt");
    const tr = trashRepo();
    expect(await tr.listTrash(USER_B, tx)).toEqual([]);
  });

  // getTrashNode ────────────────────────────────────────────────────────
  it("getTrashNode: B cannot see A's trashed node", async () => {
    const { nodeId } = await seedTrashedFile(USER_A, "secret.txt");
    const tr = trashRepo();
    expect(await tr.getTrashNode(USER_B, nodeId, tx)).toBeNull();
    expect(await tr.getTrashNode(USER_A, nodeId, tx)).not.toBeNull();
  });

  // purgeUserTrash ──────────────────────────────────────────────────────
  it("purgeUserTrash: scoped to caller; A's purge does not touch B", async () => {
    const { nodeId: aNode } = await seedTrashedFile(USER_A, "a.txt");
    const { nodeId: bNode } = await seedTrashedFile(USER_B, "b.txt");
    const tr = trashRepo();
    const result = await tr.purgeUserTrash(USER_A, tx);
    expect(result.nodes.map((n) => n.id)).toEqual([aNode]);
    // B's trash untouched
    expect(await tr.getTrashNode(USER_B, bNode, tx)).not.toBeNull();
    expect(await tr.listTrash(USER_B, tx)).toHaveLength(1);
  });

  it("purgeUserTrash: only returns own revisions", async () => {
    await seedTrashedFile(USER_A, "a.txt");
    await seedTrashedFile(USER_B, "b.txt");
    const tr = trashRepo();
    const result = await tr.purgeUserTrash(USER_A, tx);
    // Only A's revision storage_prefix should appear
    expect(result.revisions.map((r) => r.storagePrefix)).toEqual([
      "r2/rev_user_a_trash_a.txt",
    ]);
  });

  // purgeNode ───────────────────────────────────────────────────────────
  it("purgeNode: B cannot hard-delete A's node by id", async () => {
    const r = repo();
    const tr = trashRepo();
    const node = await r.createNode(
      { userId: USER_A, parentId: "", name: "live.txt", isDirectory: false },
      tx,
    );
    const result = await tr.purgeNode(USER_B, node.id, tx);
    expect(result).toBeNull();
    // Still alive for A
    expect(await r.getNode(USER_A, node.id, tx)).not.toBeNull();
  });

  it("purgeNode: A can hard-delete own node (sanity)", async () => {
    const r = repo();
    const tr = trashRepo();
    const node = await r.createNode(
      { userId: USER_A, parentId: "", name: "live.txt", isDirectory: false },
      tx,
    );
    const result = await tr.purgeNode(USER_A, node.id, tx);
    expect(result).not.toBeNull();
    expect(await r.getNode(USER_A, node.id, tx)).toBeNull();
  });

  // purgeTrashSubtree ───────────────────────────────────────────────────
  it("purgeTrashSubtree: B cannot purge A's trashed subtree", async () => {
    const { nodeId } = await seedTrashedFile(USER_A, "a.txt");
    const tr = trashRepo();
    expect(await tr.purgeTrashSubtree(USER_B, nodeId, tx)).toBeNull();
    // Still in trash for A
    expect(await tr.getTrashNode(USER_A, nodeId, tx)).not.toBeNull();
  });

  it("purgeTrashSubtree: B's purge of A's trashed dir subtree is rejected and leaves descendants", async () => {
    const r = repo();
    const tr = trashRepo();
    const dir = await r.createNode(
      { userId: USER_A, parentId: "", name: "dir", isDirectory: true },
      tx,
    );
    const child = await r.createNode(
      {
        userId: USER_A,
        parentId: dir.id,
        name: "child.txt",
        isDirectory: false,
      },
      tx,
    );
    await tr.softDeleteNode(USER_A, dir.id, tx);
    // B tries to purge → null, no rows touched
    expect(await tr.purgeTrashSubtree(USER_B, dir.id, tx)).toBeNull();
    expect(await tr.getTrashNode(USER_A, dir.id, tx)).not.toBeNull();
    expect(await tr.getTrashNode(USER_A, child.id, tx)).not.toBeNull();
  });
});
