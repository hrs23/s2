import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "~/lib/db/client.server";
import { FileNodeRepository } from "~/lib/files/file-node-repository.server";
import { splitPath } from "~/lib/files/paths";
import { TrashRepository } from "~/lib/files/trash-repository.server";
import { VersionRepository } from "~/lib/files/version-repository.server";
import { asTestTx, seedTestUser } from "~/test/integration-helpers";
import { createTestDb } from "~/test/test-db";

let tx: ReturnType<typeof asTestTx>;
const USER = "user_test_001";

let db: DbClient;

beforeAll(async () => {
  db = await createTestDb();

  tx = asTestTx(db);
});

beforeEach(async () => {
  // Clean file_nodes between tests
  await db.execute("DELETE FROM file_nodes");
  // Ensure test user exists (FK constraint on user_id)
  await seedTestUser(db, { id: USER, email: `${USER}@test.local` });
});

function repo(): FileNodeRepository {
  return new FileNodeRepository();
}

function trashRepo(): TrashRepository {
  return new TrashRepository();
}

function versionRepo(): VersionRepository {
  return new VersionRepository();
}

describe("splitPath", () => {
  it("splits path into segments", () => {
    expect(splitPath("/docs/project/report.pdf")).toEqual([
      "docs",
      "project",
      "report.pdf",
    ]);
  });

  it("handles root", () => {
    expect(splitPath("/")).toEqual([]);
    expect(splitPath("")).toEqual([]);
  });

  it("handles trailing slash", () => {
    expect(splitPath("/docs/")).toEqual(["docs"]);
  });
});

describe("FileNodeRepository", () => {
  it("createNode + getNode roundtrip", async () => {
    const r = repo();
    const node = await r.createNode(
      { userId: USER, parentId: "", name: "docs", isDirectory: true },
      tx,
    );
    expect(node.name).toBe("docs");
    expect(node.isDirectory).toBe(true);
    expect(node.parentId).toBe("");

    const fetched = await r.getNode(USER, node.id, tx);
    expect(fetched).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(fetched!.name).toBe("docs");
  });

  it("resolvePath walks the tree", async () => {
    const r = repo();
    const docs = await r.createNode(
      { userId: USER, parentId: "", name: "docs", isDirectory: true },
      tx,
    );
    const file = await r.createNode(
      {
        userId: USER,
        parentId: docs.id,
        name: "report.pdf",
        isDirectory: false,
        contentType: "application/pdf",
        size: 1024,
      },
      tx,
    );

    const resolved = await r.resolvePath(USER, ["docs", "report.pdf"], tx);
    expect(resolved).toBe(file.id);
  });

  it("resolvePath returns null for missing path", async () => {
    const r = repo();
    const result = await r.resolvePath(USER, ["nonexistent"], tx);
    expect(result).toBeNull();
  });

  it("getChildren lists direct children with decrypted names", async () => {
    const r = repo();
    const dir = await r.createNode(
      { userId: USER, parentId: "", name: "mydir", isDirectory: true },
      tx,
    );
    await r.createNode(
      { userId: USER, parentId: dir.id, name: "a.txt", isDirectory: false },
      tx,
    );
    await r.createNode(
      { userId: USER, parentId: dir.id, name: "b.txt", isDirectory: false },
      tx,
    );
    await r.createNode(
      { userId: USER, parentId: dir.id, name: "sub", isDirectory: true },
      tx,
    );

    const children = await r.getChildren(USER, dir.id, tx);
    expect(children).toHaveLength(3);
    const names = children.map((c) => c.name).sort();
    expect(names).toEqual(["a.txt", "b.txt", "sub"]);
  });

  it("ensureDirectoryPath creates intermediate dirs", async () => {
    const r = repo();
    const leafId = await r.ensureDirectoryPath(USER, ["a", "b", "c"], tx);
    expect(leafId).toBeTruthy();

    // Verify the tree
    const aId = await r.resolvePath(USER, ["a"], tx);
    const bId = await r.resolvePath(USER, ["a", "b"], tx);
    const cId = await r.resolvePath(USER, ["a", "b", "c"], tx);
    expect(aId).toBeTruthy();
    expect(bId).toBeTruthy();
    expect(cId).toBe(leafId);

    // All are directories
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const a = await r.getNode(USER, aId!, tx);
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    expect(a!.isDirectory).toBe(true);
  });

  it("ensureDirectoryPath is idempotent", async () => {
    const r = repo();
    const id1 = await r.ensureDirectoryPath(USER, ["x", "y"], tx);
    const id2 = await r.ensureDirectoryPath(USER, ["x", "y"], tx);
    expect(id1).toBe(id2);
  });

  it("ensureDirectoryPath rejects file as intermediate segment", async () => {
    const r = repo();
    await r.createNode(
      { userId: USER, parentId: "", name: "file.txt", isDirectory: false },
      tx,
    );
    await expect(
      r.ensureDirectoryPath(USER, ["file.txt", "sub"], tx),
    ).rejects.toThrow("not a directory");
  });

  it("resolveOrCreate creates file with parent dirs", async () => {
    const r = repo();
    const { nodeId, existed } = await r.resolveOrCreate(
      {
        userId: USER,
        segments: ["deep", "path", "file.txt"],
        isDirectory: false,
        contentType: "text/plain",
        size: 42,
      },
      tx,
    );
    expect(existed).toBe(false);
    expect(nodeId).toBeTruthy();

    // Verify parents were created
    expect(await r.resolvePath(USER, ["deep"], tx)).toBeTruthy();
    expect(await r.resolvePath(USER, ["deep", "path"], tx)).toBeTruthy();
  });

  it("resolveOrCreate returns existing node", async () => {
    const r = repo();
    const first = await r.resolveOrCreate(
      { userId: USER, segments: ["test.txt"], isDirectory: false },
      tx,
    );
    const second = await r.resolveOrCreate(
      { userId: USER, segments: ["test.txt"], isDirectory: false },
      tx,
    );
    expect(second.nodeId).toBe(first.nodeId);
    expect(second.existed).toBe(true);
  });

  it("moveNode renames a file", async () => {
    const r = repo();
    const node = await r.createNode(
      { userId: USER, parentId: "", name: "old.txt", isDirectory: false },
      tx,
    );
    await r.moveNode(USER, node.id, "", "new.txt", tx);

    const moved = await r.getNode(USER, node.id, tx);
    // biome-ignore lint/style/noNonNullAssertion: asserted by moveNode success
    expect(moved!.name).toBe("new.txt");
    expect(await r.resolvePath(USER, ["old.txt"], tx)).toBeNull();
    expect(await r.resolvePath(USER, ["new.txt"], tx)).toBe(node.id);
  });

  it("moveNode moves to different parent", async () => {
    const r = repo();
    const dir1 = await r.createNode(
      { userId: USER, parentId: "", name: "dir1", isDirectory: true },
      tx,
    );
    const dir2 = await r.createNode(
      { userId: USER, parentId: "", name: "dir2", isDirectory: true },
      tx,
    );
    const file = await r.createNode(
      {
        userId: USER,
        parentId: dir1.id,
        name: "file.txt",
        isDirectory: false,
      },
      tx,
    );

    await r.moveNode(USER, file.id, dir2.id, "file.txt", tx);

    expect(await r.resolvePath(USER, ["dir1", "file.txt"], tx)).toBeNull();
    expect(await r.resolvePath(USER, ["dir2", "file.txt"], tx)).toBe(file.id);
  });

  it("moveNode rejects circular move", async () => {
    const r = repo();
    const a = await r.createNode(
      { userId: USER, parentId: "", name: "a", isDirectory: true },
      tx,
    );
    const b = await r.createNode(
      { userId: USER, parentId: a.id, name: "b", isDirectory: true },
      tx,
    );

    // Try to move /a into /a/b (would create cycle)
    await expect(r.moveNode(USER, a.id, b.id, "a", tx)).rejects.toThrow(
      "Cannot move a directory into its own subtree",
    );
  });

  it("reconstructPath builds full path", async () => {
    const r = repo();
    const docs = await r.createNode(
      { userId: USER, parentId: "", name: "docs", isDirectory: true },
      tx,
    );
    const file = await r.createNode(
      {
        userId: USER,
        parentId: docs.id,
        name: "report.pdf",
        isDirectory: false,
      },
      tx,
    );

    const path = await r.reconstructPath(USER, file.id, tx);
    expect(path).toBe("/docs/report.pdf");
  });

  it("same name in different parents is allowed", async () => {
    const r = repo();
    const dir1 = await r.createNode(
      { userId: USER, parentId: "", name: "dir1", isDirectory: true },
      tx,
    );
    const dir2 = await r.createNode(
      { userId: USER, parentId: "", name: "dir2", isDirectory: true },
      tx,
    );

    const f1 = await r.createNode(
      {
        userId: USER,
        parentId: dir1.id,
        name: "same.txt",
        isDirectory: false,
      },
      tx,
    );
    const f2 = await r.createNode(
      {
        userId: USER,
        parentId: dir2.id,
        name: "same.txt",
        isDirectory: false,
      },
      tx,
    );
    expect(f1.id).not.toBe(f2.id);
  });

  it("duplicate name in same parent is rejected", async () => {
    const r = repo();
    await r.createNode(
      { userId: USER, parentId: "", name: "unique.txt", isDirectory: false },
      tx,
    );
    await expect(
      r.createNode(
        { userId: USER, parentId: "", name: "unique.txt", isDirectory: false },
        tx,
      ),
    ).rejects.toThrow();
  });

  it("NFC normalization: NFD and NFC names resolve to same node", async () => {
    const r = repo();
    const nfd = "\u304B\u3099"; // KA + combining dakuten (NFD)
    const nfc = "\u304C"; // GA (NFC)
    await r.createNode(
      { userId: USER, parentId: "", name: nfd, isDirectory: false },
      tx,
    );

    // Should find the same node regardless of normalization form
    const byNfd = await r.resolvePath(USER, [nfd], tx);
    const byNfc = await r.resolvePath(USER, [nfc], tx);
    expect(byNfd).toBe(byNfc);
    expect(byNfd).toBeTruthy();
  });

  it("reconstructPath returns / for physically deleted node", async () => {
    const r = repo();
    const node = await r.createNode(
      { userId: USER, parentId: "", name: "temp.txt", isDirectory: false },
      tx,
    );
    await tx.execute("DELETE FROM file_nodes WHERE user_id = $1 AND id = $2", [
      USER,
      node.id,
    ]);
    const path = await r.reconstructPath(USER, node.id, tx);
    expect(path).toBe("/");
  });

  it("reconstructPath returns correct path for soft-deleted node", async () => {
    const r = repo();
    const tr = trashRepo();
    const docs = await r.createNode(
      { userId: USER, parentId: "", name: "docs", isDirectory: true },
      tx,
    );
    const file = await r.createNode(
      {
        userId: USER,
        parentId: docs.id,
        name: "report.pdf",
        isDirectory: false,
      },
      tx,
    );
    await tr.softDeleteNode(USER, file.id, tx);
    // After soft deletion, reconstructPath should still return the path
    const path = await r.reconstructPath(USER, file.id, tx);
    expect(path).toBe("/docs/report.pdf");
  });

  // ---- New methods ------------------------------------------------

  it("getRevisionWithNode returns revision + node info", async () => {
    const r = repo();
    const v = versionRepo();
    const node = await r.createNode(
      { userId: USER, parentId: "", name: "file.txt", isDirectory: false },
      tx,
    );
    await r.createRevision(
      USER,
      node.id,
      "rev1",
      {
        storagePrefix: "r2/rev1",
        contentType: "text/plain",
        chunkCount: 1,
        size: 42,
        hash: "h1",
      },
      0,
      tx,
    );

    const info = await v.getRevisionWithNode("rev1", tx);
    expect(info).not.toBeNull();
    expect(info?.nodeId).toBe(node.id);
    expect(info?.userId).toBe(USER);
    expect(info?.size).toBe(42);
    expect(info?.isDirectory).toBe(false);
  });

  it("getRevisionWithNode returns null for unknown revision", async () => {
    const v = versionRepo();
    const result = await v.getRevisionWithNode("nonexistent", tx);
    expect(result).toBeNull();
  });

  it("deleteNonCurrentRevision deletes non-current and returns info", async () => {
    const r = repo();
    const v = versionRepo();
    const node = await r.createNode(
      { userId: USER, parentId: "", name: "file.txt", isDirectory: false },
      tx,
    );
    // Create 2 revisions
    await r.createRevision(
      USER,
      node.id,
      "rev_old",
      {
        storagePrefix: "r2/old",
        contentType: "text/plain",
        chunkCount: 1,
        size: 10,
        hash: "h1",
      },
      0,
      tx,
    );
    await r.createRevision(
      USER,
      node.id,
      "rev_new",
      {
        storagePrefix: "r2/new",
        contentType: "text/plain",
        chunkCount: 1,
        size: 20,
        hash: "h2",
      },
      1,
      tx,
    );

    // Delete the old (non-current) revision
    const result = await v.deleteNonCurrentRevision("rev_old", tx);
    expect(result).not.toBeNull();
    expect(result?.size).toBe(10);
    expect(result?.storagePrefix).toBe("r2/old");

    // Only 1 revision left
    const revisions = await v.listRevisions(node.id, tx);
    expect(revisions).toHaveLength(1);
  });

  it("deleteNonCurrentRevision returns null for current revision", async () => {
    const r = repo();
    const v = versionRepo();
    const node = await r.createNode(
      { userId: USER, parentId: "", name: "file.txt", isDirectory: false },
      tx,
    );
    await r.createRevision(
      USER,
      node.id,
      "rev1",
      {
        storagePrefix: "r2/rev1",
        contentType: "text/plain",
        chunkCount: 1,
        size: 10,
        hash: "h1",
      },
      0,
      tx,
    );

    // Try to delete the current revision — should return null
    const result = await v.deleteNonCurrentRevision("rev1", tx);
    expect(result).toBeNull();
  });

  it("getTrashNode returns trashed node", async () => {
    const r = repo();
    const tr = trashRepo();
    const node = await r.createNode(
      { userId: USER, parentId: "", name: "trash-me.txt", isDirectory: false },
      tx,
    );
    await tr.softDeleteNode(USER, node.id, tx);

    const trashNode = await tr.getTrashNode(USER, node.id, tx);
    expect(trashNode).not.toBeNull();
    expect(trashNode?.name).toBe("trash-me.txt");
  });

  it("getTrashNode returns null for live node", async () => {
    const tr = trashRepo();
    const r = repo();
    const node = await r.createNode(
      { userId: USER, parentId: "", name: "live.txt", isDirectory: false },
      tx,
    );
    const result = await tr.getTrashNode(USER, node.id, tx);
    expect(result).toBeNull();
  });

  it("purgeTrashSubtree deletes node and descendants", async () => {
    const r = repo();
    const tr = trashRepo();
    const dir = await r.createNode(
      { userId: USER, parentId: "", name: "dir", isDirectory: true },
      tx,
    );
    const child = await r.createNode(
      { userId: USER, parentId: dir.id, name: "file.txt", isDirectory: false },
      tx,
    );
    await r.createRevision(
      USER,
      child.id,
      "rev1",
      {
        storagePrefix: "r2/rev1",
        contentType: "text/plain",
        chunkCount: 1,
        size: 100,
        hash: "h1",
      },
      0,
      tx,
    );
    await tr.softDeleteNode(USER, dir.id, tx);

    const result = await tr.purgeTrashSubtree(USER, dir.id, tx);
    expect(result).not.toBeNull();
    expect(result?.nodeIds).toHaveLength(2);
    expect(result?.isDirectory).toBe(true);
    expect(result?.totalSize).toBe(100);
    expect(result?.revisions).toHaveLength(1);

    // Verify nodes are gone
    expect(await tr.getTrashNode(USER, dir.id, tx)).toBeNull();
    expect(await tr.getTrashNode(USER, child.id, tx)).toBeNull();
  });

  it("purgeTrashSubtree returns null for non-trashed node", async () => {
    const r = repo();
    const tr = trashRepo();
    const node = await r.createNode(
      { userId: USER, parentId: "", name: "live.txt", isDirectory: false },
      tx,
    );
    const result = await tr.purgeTrashSubtree(USER, node.id, tx);
    expect(result).toBeNull();
  });

  it("different users are isolated", async () => {
    // Ensure both users exist (FK constraint)
    await seedTestUser(db, { id: "user_a", email: "user_a@test.local" });
    await seedTestUser(db, { id: "user_b", email: "user_b@test.local" });
    const r = repo();
    await r.createNode(
      {
        userId: "user_a",
        parentId: "",
        name: "shared.txt",
        isDirectory: false,
      },
      tx,
    );
    const result = await r.resolvePath("user_b", ["shared.txt"], tx);
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// cross-user isolation guards (pre-RLS).
// Each test seeds two users (A and B), creates resources as A, then tries
// to access them as B. Every read must return null/empty; every write
// must affect 0 rows / no-op (or throw without touching A's data).
// When these fail, the underlying code is missing a `WHERE user_id = $`
// guard — fix the code, not the test.
// ─────────────────────────────────────────────────────────────────────────
describe("FileNodeRepository — cross-user isolation", () => {
  const USER_A = "user_a_xuser";
  const USER_B = "user_b_xuser";

  beforeEach(async () => {
    await seedTestUser(db, { id: USER_A, email: `${USER_A}@test.local` });
    await seedTestUser(db, { id: USER_B, email: `${USER_B}@test.local` });
  });

  // resolvePath ─────────────────────────────────────────────────────────
  it("resolvePath: B cannot resolve A's path", async () => {
    const r = repo();
    await r.createNode(
      { userId: USER_A, parentId: "", name: "secret.txt", isDirectory: false },
      tx,
    );
    expect(await r.resolvePath(USER_B, ["secret.txt"], tx)).toBeNull();
  });

  it("resolvePath: B cannot resolve nested path owned by A", async () => {
    const r = repo();
    const dir = await r.createNode(
      { userId: USER_A, parentId: "", name: "dir", isDirectory: true },
      tx,
    );
    await r.createNode(
      {
        userId: USER_A,
        parentId: dir.id,
        name: "leaf.txt",
        isDirectory: false,
      },
      tx,
    );
    expect(await r.resolvePath(USER_B, ["dir", "leaf.txt"], tx)).toBeNull();
  });

  // getNode ─────────────────────────────────────────────────────────────
  it("getNode: B cannot read A's node by id", async () => {
    const r = repo();
    const node = await r.createNode(
      { userId: USER_A, parentId: "", name: "a.txt", isDirectory: false },
      tx,
    );
    expect(await r.getNode(USER_B, node.id, tx)).toBeNull();
    // sanity: A still sees it
    expect(await r.getNode(USER_A, node.id, tx)).not.toBeNull();
  });

  // getChildren ─────────────────────────────────────────────────────────
  it("getChildren: B sees empty list for A's directory id", async () => {
    const r = repo();
    const dir = await r.createNode(
      { userId: USER_A, parentId: "", name: "dir", isDirectory: true },
      tx,
    );
    await r.createNode(
      { userId: USER_A, parentId: dir.id, name: "child1", isDirectory: false },
      tx,
    );
    await r.createNode(
      { userId: USER_A, parentId: dir.id, name: "child2", isDirectory: false },
      tx,
    );
    expect(await r.getChildren(USER_B, dir.id, tx)).toEqual([]);
  });

  it("getChildren: B at root sees only their own children", async () => {
    const r = repo();
    await r.createNode(
      { userId: USER_A, parentId: "", name: "a-only.txt", isDirectory: false },
      tx,
    );
    await r.createNode(
      { userId: USER_B, parentId: "", name: "b-only.txt", isDirectory: false },
      tx,
    );
    const aChildren = await r.getChildren(USER_A, "", tx);
    const bChildren = await r.getChildren(USER_B, "", tx);
    expect(aChildren.map((c) => c.name)).toEqual(["a-only.txt"]);
    expect(bChildren.map((c) => c.name)).toEqual(["b-only.txt"]);
  });

  // createRevision ──────────────────────────────────────────────────────
  it("createRevision: B cannot append a revision to A's node", async () => {
    const r = repo();
    const node = await r.createNode(
      { userId: USER_A, parentId: "", name: "doc.txt", isDirectory: false },
      tx,
    );
    // The composite FK (node_id, user_id) → file_nodes(id, user_id) rejects it
    // at the schema level, before the app-level CAS UPDATE is ever reached.
    await expect(
      r.createRevision(
        USER_B,
        node.id,
        "rev_intruder",
        {
          storagePrefix: "r2/x",
          contentType: "text/plain",
          chunkCount: 1,
          size: 1,
          hash: "h",
        },
        0,
        tx,
      ),
    ).rejects.toThrow(/foreign key/i);
    // A's node version untouched
    const aNode = await r.getNode(USER_A, node.id, tx);
    expect(aNode?.contentVersion).toBe(0);
    expect(aNode?.currentRevisionId).toBeNull();
  });

  // restoreRevision ─────────────────────────────────────────────────────
  it("restoreRevision: B cannot restore A's historical revision", async () => {
    const r = repo();
    const node = await r.createNode(
      { userId: USER_A, parentId: "", name: "doc.txt", isDirectory: false },
      tx,
    );
    await r.createRevision(
      USER_A,
      node.id,
      "rev_a1",
      {
        storagePrefix: "r2/a1",
        contentType: "text/plain",
        chunkCount: 1,
        size: 10,
        hash: "h1",
      },
      0,
      tx,
    );
    await r.createRevision(
      USER_A,
      node.id,
      "rev_a2",
      {
        storagePrefix: "r2/a2",
        contentType: "text/plain",
        chunkCount: 1,
        size: 20,
        hash: "h2",
      },
      1,
      tx,
    );
    // B tries to restore the older revision → must be rejected. The first
    // lookup (file_revisions by id + node_id) succeeds (not user-scoped at
    // the SQL level), but the UPDATE filters by user_id and so no row is
    // touched → "conflict" (not revision_gone).
    const outcome = await r.restoreRevision(USER_B, node.id, "rev_a1", 2, tx);
    expect(outcome).toBe("conflict");
    const after = await r.getNode(USER_A, node.id, tx);
    expect(after?.currentRevisionId).toBe("rev_a2");
  });

  // isAncestor ──────────────────────────────────────────────────────────
  it("isAncestor: B sees no ancestor relationship in A's tree", async () => {
    const r = repo();
    const a = await r.createNode(
      { userId: USER_A, parentId: "", name: "a", isDirectory: true },
      tx,
    );
    const b = await r.createNode(
      { userId: USER_A, parentId: a.id, name: "b", isDirectory: true },
      tx,
    );
    // For A this is true; for B the chain is empty so it's false.
    expect(await r.isAncestor(USER_A, a.id, b.id, tx)).toBe(true);
    expect(await r.isAncestor(USER_B, a.id, b.id, tx)).toBe(false);
  });

  // moveNode ────────────────────────────────────────────────────────────
  it("moveNode: B cannot move A's node", async () => {
    const r = repo();
    const node = await r.createNode(
      { userId: USER_A, parentId: "", name: "f.txt", isDirectory: false },
      tx,
    );
    const ok = await r.moveNode(USER_B, node.id, "", "renamed.txt", tx);
    expect(ok).toBe(false);
    const after = await r.getNode(USER_A, node.id, tx);
    expect(after?.name).toBe("f.txt");
  });

  it("moveNode: B cannot move A's node into a B directory", async () => {
    const r = repo();
    const aFile = await r.createNode(
      { userId: USER_A, parentId: "", name: "a.txt", isDirectory: false },
      tx,
    );
    const bDir = await r.createNode(
      { userId: USER_B, parentId: "", name: "bdir", isDirectory: true },
      tx,
    );
    const ok = await r.moveNode(USER_B, aFile.id, bDir.id, "stolen.txt", tx);
    expect(ok).toBe(false);
    // file still belongs to A, still at root, still named a.txt
    const after = await r.getNode(USER_A, aFile.id, tx);
    expect(after?.parentId).toBe("");
    expect(after?.name).toBe("a.txt");
  });

  // ensureDirectoryPath ─────────────────────────────────────────────────
  it("ensureDirectoryPath: B operating with same path creates B's own tree", async () => {
    const r = repo();
    const aRoot = await r.ensureDirectoryPath(USER_A, ["proj"], tx);
    const bRoot = await r.ensureDirectoryPath(USER_B, ["proj"], tx);
    expect(aRoot).not.toBe(bRoot);
    // A's "proj" still owned by A
    const aNode = await r.getNode(USER_A, aRoot, tx);
    expect(aNode?.userId).toBe(USER_A);
    // B's "proj" is owned by B, invisible to A
    expect(await r.getNode(USER_A, bRoot, tx)).toBeNull();
  });

  // resolveOrCreate ─────────────────────────────────────────────────────
  it("resolveOrCreate: B with same path creates a separate B node", async () => {
    const r = repo();
    const aResult = await r.resolveOrCreate(
      { userId: USER_A, segments: ["docs", "report.pdf"], isDirectory: false },
      tx,
    );
    const bResult = await r.resolveOrCreate(
      { userId: USER_B, segments: ["docs", "report.pdf"], isDirectory: false },
      tx,
    );
    expect(aResult.nodeId).not.toBe(bResult.nodeId);
    expect(aResult.existed).toBe(false);
    expect(bResult.existed).toBe(false);
    // Owner check
    const aNode = await r.getNode(USER_A, aResult.nodeId, tx);
    const bNode = await r.getNode(USER_B, bResult.nodeId, tx);
    expect(aNode?.userId).toBe(USER_A);
    expect(bNode?.userId).toBe(USER_B);
  });

  // reconstructPath ─────────────────────────────────────────────────────
  it("reconstructPath: B querying A's nodeId returns / (no traversal)", async () => {
    const r = repo();
    const dir = await r.createNode(
      { userId: USER_A, parentId: "", name: "docs", isDirectory: true },
      tx,
    );
    const file = await r.createNode(
      {
        userId: USER_A,
        parentId: dir.id,
        name: "report.pdf",
        isDirectory: false,
      },
      tx,
    );
    expect(await r.reconstructPath(USER_B, file.id, tx)).toBe("/");
    expect(await r.reconstructPath(USER_A, file.id, tx)).toBe(
      "/docs/report.pdf",
    );
  });
});
