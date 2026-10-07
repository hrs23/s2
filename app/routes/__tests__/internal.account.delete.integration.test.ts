// @ts-nocheck
// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  issueTestToken,
  sessionCookieHeader,
  type TestEnv,
  testLoadContext,
} from "~/test/integration-helpers";
import { action } from "../internal.account.delete";

let testEnv: TestEnv;
const USER_ID = "user_del_acct";

function ctx() {
  return testLoadContext(testEnv);
}

async function deleteReq(cookie?: string): Promise<Request> {
  const h = new Headers();
  if (cookie) h.set("Cookie", cookie);
  return new Request("http://localhost/internal/account/delete", {
    method: "POST",
    headers: h,
  });
}

beforeAll(async () => {
  testEnv = await createTestEnv();
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
});

describe("POST /internal/account/delete", () => {
  it("returns 401 without auth", async () => {
    const res = await action({
      request: await deleteReq(),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(401);
  });

  it("returns 405 for GET", async () => {
    await createTestUser(testEnv.db, { id: USER_ID });
    const cookie = await sessionCookieHeader(USER_ID, testEnv.env);
    const res = await action({
      request: new Request("http://localhost/internal/account/delete", {
        method: "GET",
        headers: { Cookie: cookie },
      }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(405);
  });

  it("deletes user and all related data", async () => {
    const user = await createTestUser(testEnv.db, { id: USER_ID });
    const cookie = await sessionCookieHeader(user.id, testEnv.env);

    // Create account (Better Auth `account` table)
    await testEnv.db.execute(
      `INSERT INTO "account" (id, "userId", "providerId", "accountId", "createdAt", "updatedAt")
       VALUES ($1, $2, 'github', '12345', now(), now())`,
      ["acc_1", user.id],
    );

    // Create token with access paths
    await issueTestToken(testEnv.db, { userId: user.id, name: "Default" });

    // Create file_node + file_revisions row so the DELETE CASCADE flows
    // through the file_revisions DELETE trigger and enqueues a tombstone
    //.
    await testEnv.db.execute(
      "INSERT INTO file_nodes (id, user_id, parent_id, name, created_at, cached_size) VALUES ($1, $2, NULL, 'test-file', now(), 100)",
      ["node_1", user.id],
    );
    const storagePrefix = `${user.id}/node_1/u/att1`;
    await testEnv.db.execute(
      `INSERT INTO file_revisions (id, node_id, user_id, storage_prefix, content_type, chunk_count, size, hash)
       SELECT $1, id, user_id, $2, 'text/plain', 1, 100, 'h' FROM file_nodes WHERE id = 'node_1'`,
      ["rev_1", storagePrefix],
    );
    await testEnv.db.execute(
      "UPDATE file_nodes SET current_revision_id = $1 WHERE id = $2",
      ["rev_1", "node_1"],
    );

    // Create upload_session (should be cleaned up by CASCADE)
    await testEnv.db.execute(
      `INSERT INTO upload_sessions (id, user_id, node_id, base_content_version, revision_id, total_size, expires_at, created_at)
       VALUES ($1, $2, $3, 0, 'rev_1', 1024, now() + interval '1 hour', now())`,
      ["sess_1", user.id, "node_1"],
    );

    // Put a storage object under the user's prefix.
    // account delete no longer touches storage directly. The trigger
    // queues a tombstone; storage-gc reaps blobs once the grace window
    // elapses. We assert the tombstone shows up below.
    await testEnv.storage.put(
      `${user.id}/node_1/u/att1/c/00000`,
      new ArrayBuffer(10),
    );

    const res = await action({
      request: await deleteReq(cookie),
      context: ctx(),
      params: {},
    });

    expect(res.status).toBe(200);

    // Verify user is gone (Better Auth's session row is CASCADE-deleted with
    // the user; the cookie becomes useless on the next request even though
    // we no longer set Max-Age=0 explicitly).
    const userRow = await testEnv.db.queryOne(
      `SELECT id FROM "user" WHERE id = $1`,
      [user.id],
    );
    expect(userRow).toBeNull();

    // Verify related tables are empty (CASCADE)
    const identities = await testEnv.db.query(
      `SELECT * FROM "account" WHERE "userId" = $1`,
      [user.id],
    );
    expect(identities).toHaveLength(0);

    const tokens = await testEnv.db.query(
      "SELECT * FROM grants WHERE user_id = $1",
      [user.id],
    );
    expect(tokens).toHaveLength(0);

    const fileNodes = await testEnv.db.query(
      "SELECT * FROM file_nodes WHERE user_id = $1",
      [user.id],
    );
    expect(fileNodes).toHaveLength(0);

    const uploadSessions = await testEnv.db.query(
      "SELECT * FROM upload_sessions WHERE user_id = $1",
      [user.id],
    );
    expect(uploadSessions).toHaveLength(0);

    // storage stays untouched at delete time; storage-gc reaps it
    // after GC_GRACE_DAYS. The CASCADE through file_revisions enqueues
    // exactly one tombstone for the storage_prefix.
    const storageObjects = await testEnv.storage.list(`${user.id}/`);
    expect(storageObjects).toHaveLength(1);

    const tombstones = await testEnv.db.query<{ storage_prefix: string }>(
      "SELECT storage_prefix FROM storage_tombstones WHERE storage_prefix LIKE $1",
      [`${user.id}/%`],
    );
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].storage_prefix).toBe(storagePrefix);
  });

  it("deletes user with parent + child delegation tree (RESTRICT does not block)", async () => {
    // ON DELETE RESTRICT is set on user_grants self-FK to prevent a
    // single-row token delete from wiping a delegation subtree. Pin behaviour
    // for the user-cascade path: a `DELETE FROM "user"` removes both parent
    // and child user_grants in the same statement, and PostgreSQL evaluates
    // FK constraints against the post-statement state — so RESTRICT does NOT
    // fire and the cascade succeeds. If this test ever flips, we need a
    // dedicated user-data purge that walks delegation children first.
    const userA = await createTestUser(testEnv.db, { id: "user_del_tree_a" });
    const userB = await createTestUser(testEnv.db, { id: "user_del_tree_b" });
    const cookieA = await sessionCookieHeader(userA.id, testEnv.env);

    // Build A: parent → child delegation chain.
    const parent = await issueTestToken(testEnv.db, {
      userId: userA.id,
      name: "parent",
      canDelegate: true,
    });
    const childId = `tok_child_${crypto.randomUUID().slice(0, 8)}`;
    await testEnv.db.execute(
      "INSERT INTO grants (id, user_id, base_path, created_at) VALUES ($1, $2, '/', now())",
      [childId, userA.id],
    );
    await testEnv.db.execute(
      `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
       VALUES ($1, $2, 'child', false, $3)`,
      [childId, userA.id, parent.id],
    );
    await testEnv.db.execute(
      "INSERT INTO grant_paths (grant_id, path, access) VALUES ($1, '', 'read')",
      [childId],
    );

    // Untouched token for user B.
    const tokB = await issueTestToken(testEnv.db, {
      userId: userB.id,
      name: "B's token",
    });

    const res = await action({
      request: await deleteReq(cookieA),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(200);

    // A's grants (parent + child) and user_grants (parent + child) gone.
    const aTokens = await testEnv.db.query(
      "SELECT id FROM grants WHERE user_id = $1",
      [userA.id],
    );
    expect(aTokens).toHaveLength(0);
    const aGrants = await testEnv.db.query(
      "SELECT grant_id FROM user_grants WHERE user_id = $1",
      [userA.id],
    );
    expect(aGrants).toHaveLength(0);

    // B's data untouched.
    const bUser = await testEnv.db.queryOne(
      `SELECT id FROM "user" WHERE id = $1`,
      [userB.id],
    );
    expect(bUser).not.toBeNull();
    const bTokens = await testEnv.db.query(
      "SELECT id FROM grants WHERE id = $1",
      [tokB.id],
    );
    expect(bTokens).toHaveLength(1);
  });

  it("does not affect other users", async () => {
    const user1 = await createTestUser(testEnv.db, { id: "user_del_1" });
    const user2 = await createTestUser(testEnv.db, { id: "user_del_2" });
    const cookie1 = await sessionCookieHeader(user1.id, testEnv.env);

    await issueTestToken(testEnv.db, { userId: user1.id });
    await issueTestToken(testEnv.db, { userId: user2.id });

    // Put storage objects for both users
    await testEnv.storage.put(`${user1.id}/file1`, new ArrayBuffer(5));
    await testEnv.storage.put(`${user2.id}/file2`, new ArrayBuffer(5));

    const res = await action({
      request: await deleteReq(cookie1),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(200);

    // user2 should still exist
    const user2Row = await testEnv.db.queryOne(
      `SELECT id FROM "user" WHERE id = $1`,
      [user2.id],
    );
    expect(user2Row).not.toBeNull();

    // user2's storage objects should still exist
    const storageObjects = await testEnv.storage.list(`${user2.id}/`);
    expect(storageObjects).toHaveLength(1);
  });
});
