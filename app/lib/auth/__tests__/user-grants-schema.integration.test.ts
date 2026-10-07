// @vitest-environment node
//
// Schema-level guard tests for user_grants composite FKs.
//
// These tests bypass the TokenRepository and write raw SQL so that the
// schema, not the application layer, is the unit under test. Each
// expectation pins a constraint that defends against cross-user delegation
// (the cross-user schema gap that RLS closes at the DB layer).
//
// What we lock in:
//  1. user_grants.user_id must match the parent grants.user_id.
//     Composite FK (grant_id, user_id) → grants(id, user_id).
//  2. user_grants.parent_grant_id must point to a user_grants row owned by
//     the same user. Composite FK (parent_grant_id, user_id) →
//     user_grants(grant_id, user_id).
//  3. ON DELETE RESTRICT for the parent FK — deleting a user_grants row
//     while a child still references it must fail (no orphan / no implicit
//     subtree wipe).
//  4. parent_grant_id cannot reference an oauth_grants row, even if the
//     grants id exists — the FK target is user_grants, not
//     grants. OAuth grants cannot act as delegation parents.
//
// PGlite supports composite FKs; these tests run on the same PGlite that
// powers the rest of the integration suite.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  type TestEnv,
} from "~/test/integration-helpers";

let testEnv: TestEnv;
const USER_A = "user_self637_a";
const USER_B = "user_self637_b";

beforeAll(async () => {
  testEnv = await createTestEnv();
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
  await createTestUser(testEnv.db, { id: USER_A });
  await createTestUser(testEnv.db, { id: USER_B });
});

async function seedTokenGrant(id: string, userId: string): Promise<void> {
  await testEnv.db.execute(
    `INSERT INTO grants (id, user_id, base_path, created_at)
     VALUES ($1, $2, '/', now())`,
    [id, userId],
  );
}

describe("user_grants composite FK on (grant_id, user_id) → grants", () => {
  it("rejects a user_grants row whose user_id differs from the parent grants.user_id", async () => {
    // A's grants row exists.
    await seedTokenGrant("tok_a_root", USER_A);

    // Try to insert a user_grants row claiming B owns it. The composite FK
    // (grant_id, user_id) → grants(id, user_id) must reject because
    // (tok_a_root, USER_B) is not present in grants.
    await expect(
      testEnv.db.execute(
        `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
         VALUES ($1, $2, 'forged', false, NULL)`,
        ["tok_a_root", USER_B],
      ),
    ).rejects.toThrow();
  });

  it("accepts a user_grants row when user_id matches the parent grants.user_id", async () => {
    await seedTokenGrant("tok_a_ok", USER_A);
    await testEnv.db.execute(
      `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
       VALUES ($1, $2, 'ok', false, NULL)`,
      ["tok_a_ok", USER_A],
    );
    const found = await testEnv.db.queryOne(
      `SELECT 1 AS one FROM user_grants WHERE grant_id = $1 AND user_id = $2`,
      ["tok_a_ok", USER_A],
    );
    expect(found).not.toBeNull();
  });
});

describe("user_grants composite FK on (parent_grant_id, user_id) → user_grants", () => {
  it("rejects a child whose parent_grant_id belongs to another user", async () => {
    // A creates a delegation-capable parent.
    await seedTokenGrant("tok_a_parent", USER_A);
    await testEnv.db.execute(
      `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
       VALUES ($1, $2, 'A parent', true, NULL)`,
      ["tok_a_parent", USER_A],
    );

    // B has a grants row of their own; the delegation-parent insert
    // must fail because (tok_a_parent, USER_B) does not exist in
    // user_grants — composite FK enforces same-user delegation.
    await seedTokenGrant("tok_b_child", USER_B);
    await expect(
      testEnv.db.execute(
        `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
         VALUES ($1, $2, 'B child of A', false, $3)`,
        ["tok_b_child", USER_B, "tok_a_parent"],
      ),
    ).rejects.toThrow();
  });

  it("accepts a child whose parent_grant_id belongs to the same user", async () => {
    await seedTokenGrant("tok_a_parent2", USER_A);
    await testEnv.db.execute(
      `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
       VALUES ($1, $2, 'A parent2', true, NULL)`,
      ["tok_a_parent2", USER_A],
    );
    await seedTokenGrant("tok_a_child", USER_A);
    await testEnv.db.execute(
      `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
       VALUES ($1, $2, 'A child', false, $3)`,
      ["tok_a_child", USER_A, "tok_a_parent2"],
    );
    const child = await testEnv.db.queryOne<{ parent_grant_id: string }>(
      `SELECT parent_grant_id FROM user_grants WHERE grant_id = $1`,
      ["tok_a_child"],
    );
    expect(child?.parent_grant_id).toBe("tok_a_parent2");
  });

  it("rejects a parent_grant_id that points at an oauth_grants row (delegation parents must be user_grants)", async () => {
    // Set up an oauth_clients + oauth_grants row for A. The parent_grant_id
    // FK targets user_grants, not grants, so even though grants
    // has the id, the composite FK to user_grants must fail.
    await testEnv.db.execute(
      `INSERT INTO oauth_clients (id, client_name, redirect_uris, token_endpoint_auth_method)
       VALUES ('oc_a', 'A app', ARRAY['https://example.test/cb'], 'none')`,
    );
    await seedTokenGrant("tok_a_oauth", USER_A);
    await testEnv.db.execute(
      `INSERT INTO oauth_grants (grant_id, user_id, oauth_client_id, oauth_requested_scopes, resource)
       VALUES ($1, $2, 'oc_a', ARRAY['files'], 'https://example.test')`,
      ["tok_a_oauth", USER_A],
    );

    // Now A tries to delegate from their own OAuth grant. The FK target is
    // user_grants, not grants, so this must be rejected.
    await seedTokenGrant("tok_a_child_of_oauth", USER_A);
    await expect(
      testEnv.db.execute(
        `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
         VALUES ($1, $2, 'child of oauth', false, $3)`,
        ["tok_a_child_of_oauth", USER_A, "tok_a_oauth"],
      ),
    ).rejects.toThrow();
  });
});

describe("ON DELETE RESTRICT on parent_grant_id", () => {
  it("blocks deletion of a user_grants row that still has children", async () => {
    // Build parent + child both owned by A.
    await seedTokenGrant("tok_a_parent3", USER_A);
    await testEnv.db.execute(
      `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
       VALUES ($1, $2, 'parent3', true, NULL)`,
      ["tok_a_parent3", USER_A],
    );
    await seedTokenGrant("tok_a_child3", USER_A);
    await testEnv.db.execute(
      `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
       VALUES ($1, $2, 'child3', false, $3)`,
      ["tok_a_child3", USER_A, "tok_a_parent3"],
    );

    // Deleting the parent grants CASCADEs to user_grants, which in
    // turn must trip the RESTRICT on the child's parent_grant_id FK. The
    // delete must therefore fail (parent must be detached or its children
    // removed first).
    await expect(
      testEnv.db.execute("DELETE FROM grants WHERE id = $1", ["tok_a_parent3"]),
    ).rejects.toThrow();

    // Both rows are still present.
    const rows = await testEnv.db.query<{ grant_id: string }>(
      `SELECT grant_id FROM user_grants WHERE user_id = $1 ORDER BY grant_id`,
      [USER_A],
    );
    expect(rows.map((r) => r.grant_id)).toEqual([
      "tok_a_child3",
      "tok_a_parent3",
    ]);
  });

  it("allows deletion of a parent once its children are removed first", async () => {
    await seedTokenGrant("tok_a_parent4", USER_A);
    await testEnv.db.execute(
      `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
       VALUES ($1, $2, 'parent4', true, NULL)`,
      ["tok_a_parent4", USER_A],
    );
    await seedTokenGrant("tok_a_child4", USER_A);
    await testEnv.db.execute(
      `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
       VALUES ($1, $2, 'child4', false, $3)`,
      ["tok_a_child4", USER_A, "tok_a_parent4"],
    );

    // Detach by deleting the leaf first, then the parent succeeds.
    await testEnv.db.execute("DELETE FROM grants WHERE id = $1", [
      "tok_a_child4",
    ]);
    await testEnv.db.execute("DELETE FROM grants WHERE id = $1", [
      "tok_a_parent4",
    ]);
    const rows = await testEnv.db.query(
      `SELECT grant_id FROM user_grants WHERE user_id = $1`,
      [USER_A],
    );
    expect(rows).toHaveLength(0);
  });
});
