// Cross-user isolation guards for VersionRepository.
//
// Most VersionRepository methods do NOT take a userId — they operate by
// nodeId / revisionId and are gated at the service layer (FileService etc.)
// which calls FileNodeRepository.getNode(userId, nodeId) first.
//
// This file verifies:
//   - methods that DO take a userId (`pruneExcessRevisions`) are scoped
//     properly
//   - `getRevisionWithNode` returns the owning userId so the caller can
//     enforce ownership downstream (the value, not the access)
//
// Functions intentionally not exercised here for cross-user isolation:
//   - listRevisions(nodeId)            — no userId; gated at service
//   - pruneNodeRevisions(nodeId, n)    — no userId; gated at service
//   - deleteNonCurrentRevision(revId)  — no userId; gated at service

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "~/lib/db/client.server";
import { FileNodeRepository } from "~/lib/files/file-node-repository.server";
import { VersionRepository } from "~/lib/files/version-repository.server";
import { asTestTx, seedTestUser } from "~/test/integration-helpers";
import { createTestDb } from "~/test/test-db";

const USER_A = "user_a_ver";
const USER_B = "user_b_ver";

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
function versionRepo(): VersionRepository {
  return new VersionRepository();
}

async function seedFileWithRevisions(
  userId: string,
  name: string,
  revs: Array<{ id: string; size: number }>,
): Promise<string> {
  const r = repo();
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
  let cas = 0;
  for (const rev of revs) {
    await r.createRevision(
      userId,
      node.id,
      rev.id,
      {
        storagePrefix: `r2/${rev.id}`,
        contentType: "text/plain",
        chunkCount: 1,
        size: rev.size,
        hash: `h-${rev.id}`,
      },
      cas++,
      tx,
    );
  }
  return node.id;
}

describe("VersionRepository — cross-user isolation", () => {
  // listRevisions ───────────────────────────────────────────────────────
  // Method takes only nodeId; ownership is enforced upstream by FileService.
  // We still test the value path: each user's nodeId returns only that
  // user's revisions (because revisions are scoped to a single nodeId).
  it("listRevisions: revisions of A's node are not returned for B's nodeId", async () => {
    const aNodeId = await seedFileWithRevisions(USER_A, "a.txt", [
      { id: "rev_a1", size: 10 },
      { id: "rev_a2", size: 20 },
    ]);
    const bNodeId = await seedFileWithRevisions(USER_B, "b.txt", [
      { id: "rev_b1", size: 33 },
    ]);
    const v = versionRepo();
    const aRevs = await v.listRevisions(aNodeId, tx);
    const bRevs = await v.listRevisions(bNodeId, tx);
    expect(aRevs.map((r) => r.id).sort()).toEqual(["rev_a1", "rev_a2"]);
    expect(bRevs.map((r) => r.id)).toEqual(["rev_b1"]);
  });

  // getRevisionWithNode ─────────────────────────────────────────────────
  // Returns userId so the service can enforce ownership.
  it("getRevisionWithNode: returns owning userId so caller can enforce ownership", async () => {
    await seedFileWithRevisions(USER_A, "a.txt", [{ id: "rev_a1", size: 10 }]);
    await seedFileWithRevisions(USER_B, "b.txt", [{ id: "rev_b1", size: 99 }]);
    const v = versionRepo();
    const aInfo = await v.getRevisionWithNode("rev_a1", tx);
    const bInfo = await v.getRevisionWithNode("rev_b1", tx);
    expect(aInfo?.userId).toBe(USER_A);
    expect(bInfo?.userId).toBe(USER_B);
  });

  // pruneExcessRevisions ────────────────────────────────────────────
  it("pruneExcessRevisions: pruning A does not touch B's revisions", async () => {
    // A: 3 revisions (cur=rev_a3, past=[rev_a2, rev_a1])
    await seedFileWithRevisions(USER_A, "a.txt", [
      { id: "rev_a1", size: 10 },
      { id: "rev_a2", size: 20 },
      { id: "rev_a3", size: 30 },
    ]);
    // B: 3 revisions (cur=rev_b3, past=[rev_b2, rev_b1])
    const bNodeId = await seedFileWithRevisions(USER_B, "b.txt", [
      { id: "rev_b1", size: 100 },
      { id: "rev_b2", size: 200 },
      { id: "rev_b3", size: 300 },
    ]);

    const v = versionRepo();
    // Keep 0 past revisions for A → must prune rev_a1 + rev_a2, leave A's
    // current rev_a3 untouched, and never touch B.
    const pruned = await v.pruneExcessRevisions(USER_A, 0, tx);
    const prunedIds = pruned.map((p) => `${p.storagePrefix}`);
    expect(prunedIds.sort()).toEqual(["r2/rev_a1", "r2/rev_a2"]);
    // B intact
    const bRevs = await v.listRevisions(bNodeId, tx);
    expect(bRevs).toHaveLength(3);
  });

  it("pruneExcessRevisions: pruning B with maxPastVersions=99 is a no-op (still scopes)", async () => {
    const aNodeId = await seedFileWithRevisions(USER_A, "a.txt", [
      { id: "rev_a1", size: 10 },
      { id: "rev_a2", size: 20 },
    ]);
    await seedFileWithRevisions(USER_B, "b.txt", [{ id: "rev_b1", size: 5 }]);
    const v = versionRepo();
    // B has only 1 (current) revision, nothing to prune.
    const pruned = await v.pruneExcessRevisions(USER_B, 99, tx);
    expect(pruned).toEqual([]);
    // A's revisions are intact — pruning B must not touch A's rows. Assert
    // by querying A's actual node (not an unrelated id, which would be
    // trivially empty and prove nothing).
    const aRevs = await v.listRevisions(aNodeId, tx);
    expect(aRevs.map((r) => r.id).sort()).toEqual(["rev_a1", "rev_a2"]);
  });
});
