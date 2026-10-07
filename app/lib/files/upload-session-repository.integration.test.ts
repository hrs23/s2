import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "~/lib/db/client.server";
import {
  asTestTx,
  FINITE_TEST_LIMITS,
  seedTestUser,
} from "~/test/integration-helpers";
import { createTestDb } from "~/test/test-db";
import { UploadSessionRepository } from "./upload-session-repository.server";

let tx: ReturnType<typeof asTestTx>;
const USER = "user_session_test";

let db: DbClient;

beforeAll(async () => {
  db = await createTestDb();

  tx = asTestTx(db);
});

beforeEach(async () => {
  await db.execute("DELETE FROM upload_session_chunks");
  await db.execute("DELETE FROM upload_sessions");
  await db.execute("DELETE FROM file_nodes");
  await db.execute(`DELETE FROM "user"`);
  await seedTestUser(db, {
    id: USER,
    email: "s@t.com",
    limits: FINITE_TEST_LIMITS,
    bytesUsed: 0,
    createdAt: "2024-01-01",
  });
  await db.execute(
    "INSERT INTO file_nodes (id, user_id, parent_id, name, content_type, is_directory, content_version, created_at) VALUES ($1,$2,NULLIF($3, ''),$4,$5,$6,$7,$8)",
    [
      "node1",
      USER,
      "",
      "test-file",
      "application/octet-stream",
      false,
      0,
      new Date().toISOString(),
    ],
  );
});

describe("UploadSessionRepository", () => {
  it("creates a session and retrieves it", async () => {
    const repo = new UploadSessionRepository();
    const session = await repo.create(
      USER,
      "node1",
      0,
      "rev_test",
      1024,
      asTestTx(db),
    );

    expect(session.id).toBeTruthy();
    expect(session.status).toBe("active");
    expect(session.totalSize).toBe(1024);

    const fetched = await repo.get(USER, session.id, tx);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(session.id);
    expect(fetched?.revisionId).toBe("rev_test");
  });

  it("returns null for unknown session", async () => {
    const repo = new UploadSessionRepository();
    const result = await repo.get(USER, "unknown", tx);
    expect(result).toBeNull();
  });

  it("returns null for another user's session", async () => {
    const repo = new UploadSessionRepository();
    const session = await repo.create(
      USER,
      "node1",
      0,
      "rev_test",
      1024,
      asTestTx(db),
    );
    const result = await repo.get("other_user", session.id, tx);
    expect(result).toBeNull();
  });

  it("updates session status", async () => {
    const repo = new UploadSessionRepository();
    const session = await repo.create(
      USER,
      "node1",
      0,
      "rev_test",
      1024,
      asTestTx(db),
    );
    const ok = await repo.setStatus(
      session.id,
      "completed",
      undefined,
      asTestTx(db),
    );
    expect(ok).toBe(true);

    const updated = await repo.get(USER, session.id, tx);
    expect(updated?.status).toBe("completed");
  });

  it("setStatus with expectedStatus acts as CAS mutex", async () => {
    const repo = new UploadSessionRepository();
    const session = await repo.create(
      USER,
      "node1",
      0,
      "rev_test",
      1024,
      asTestTx(db),
    );

    // First request acquires the lock
    const first = await repo.setStatus(
      session.id,
      "completed",
      "active",
      asTestTx(db),
    );
    expect(first).toBe(true);

    // Second concurrent request fails (status is no longer 'active')
    const second = await repo.setStatus(
      session.id,
      "completed",
      "active",
      asTestTx(db),
    );
    expect(second).toBe(false);

    const updated = await repo.get(USER, session.id, tx);
    expect(updated?.status).toBe("completed");
  });

  it("setStatus without expectedStatus always succeeds", async () => {
    const repo = new UploadSessionRepository();
    const session = await repo.create(
      USER,
      "node1",
      0,
      "rev_test",
      1024,
      asTestTx(db),
    );

    await repo.setStatus(session.id, "completed", undefined, asTestTx(db));
    const ok = await repo.setStatus(
      session.id,
      "failed",
      undefined,
      asTestTx(db),
    );
    expect(ok).toBe(true);

    const updated = await repo.get(USER, session.id, tx);
    expect(updated?.status).toBe("failed");
  });

  it("records and retrieves chunks", async () => {
    const repo = new UploadSessionRepository();
    const session = await repo.create(
      USER,
      "node1",
      0,
      "rev_test",
      1024,
      asTestTx(db),
    );

    await repo.recordChunk(session.id, 0, 4096, "etag-0", asTestTx(db));
    await repo.recordChunk(session.id, 1, 2048, "etag-1", asTestTx(db));

    const chunks = await repo.getChunks(session.id, tx);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[1].chunkIndex).toBe(1);
    expect(chunks[0].size).toBe(4096);
    expect(chunks[1].checksum).toBe("etag-1");
  });

  it("upserts chunk on duplicate index", async () => {
    const repo = new UploadSessionRepository();
    const session = await repo.create(
      USER,
      "node1",
      0,
      "rev_test",
      1024,
      asTestTx(db),
    );

    await repo.recordChunk(session.id, 0, 100, "old-etag", asTestTx(db));
    await repo.recordChunk(session.id, 0, 200, "new-etag", asTestTx(db));

    const chunks = await repo.getChunks(session.id, tx);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].size).toBe(200);
    expect(chunks[0].checksum).toBe("new-etag");
  });

  it("getUploadedSize returns cumulative size and existing chunk size", async () => {
    const repo = new UploadSessionRepository();
    const session = await repo.create(
      USER,
      "node1",
      0,
      "rev_test",
      1024,
      asTestTx(db),
    );

    await repo.recordChunk(session.id, 0, 100, "etag-0", asTestTx(db));
    await repo.recordChunk(session.id, 1, 200, "etag-1", asTestTx(db));

    const { totalUploaded, existingChunkSize } = await repo.getUploadedSize(
      session.id,
      0,
      tx,
    );
    expect(totalUploaded).toBe(300);
    expect(existingChunkSize).toBe(100);

    const noChunk = await repo.getUploadedSize(session.id, 5, tx);
    expect(noChunk.existingChunkSize).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────
  // cross-user isolation. Only `create` and `get` take a
  // userId. The other public methods (setStatus, recordChunk,
  // getUploadedSize, getChunks, delete, findExpired) operate strictly by sessionId — they are
  // gated by the service layer (UploadService) which calls
  // `sessions.get(auth.user_id, sessionId)` first. Cross-user direct
  // calls to those methods are out of scope here; coverage lives at the
  // upload-service integration test instead.
  // ───────────────────────────────────────────────────────────────────
  describe("cross-user isolation", () => {
    const USER_A = USER;
    const USER_B = "other_user_xs";

    beforeEach(async () => {
      await seedTestUser(db, {
        id: USER_B,
        email: `${USER_B}@test.local`,
        limits: FINITE_TEST_LIMITS,
      });
      // B needs a node row for `create` (FK on file_nodes)
      await db.execute(
        "INSERT INTO file_nodes (id, user_id, parent_id, name, content_type, is_directory, content_version, created_at) VALUES ($1,$2,NULLIF($3, ''),$4,$5,$6,$7,$8)",
        [
          "node1_b",
          USER_B,
          "",
          "b-file",
          "application/octet-stream",
          false,
          0,
          new Date().toISOString(),
        ],
      );
    });

    it("create: each user gets distinct sessions; B's get does not see A's", async () => {
      const repo = new UploadSessionRepository();
      const aSession = await repo.create(
        USER_A,
        "node1",
        0,
        "rev_a",
        100,
        asTestTx(db),
      );
      const bSession = await repo.create(
        USER_B,
        "node1_b",
        0,
        "rev_b",
        200,
        asTestTx(db),
      );
      expect(aSession.id).not.toBe(bSession.id);
      // B cannot read A's session via get(userId, id)
      expect(await repo.get(USER_B, aSession.id, tx)).toBeNull();
      // A cannot read B's session via get(userId, id)
      expect(await repo.get(USER_A, bSession.id, tx)).toBeNull();
      // Each user sees their own
      expect((await repo.get(USER_A, aSession.id, tx))?.userId).toBe(USER_A);
      expect((await repo.get(USER_B, bSession.id, tx))?.userId).toBe(USER_B);
    });

    it("get: returns null when caller user_id mismatches owner", async () => {
      const repo = new UploadSessionRepository();
      const session = await repo.create(
        USER_A,
        "node1",
        0,
        "rev_test",
        1024,
        asTestTx(db),
      );
      expect(await repo.get(USER_B, session.id, tx)).toBeNull();
    });
  });

  it("deletes session and cascades chunks", async () => {
    const repo = new UploadSessionRepository();
    const session = await repo.create(
      USER,
      "node1",
      0,
      "rev_test",
      1024,
      asTestTx(db),
    );
    await repo.recordChunk(session.id, 0, 512, "etag", asTestTx(db));

    await repo.delete(session.id, asTestTx(db));

    const fetched = await repo.get(USER, session.id, tx);
    expect(fetched).toBeNull();

    // Chunks should be gone via CASCADE
    const chunks = await repo.getChunks(session.id, tx);
    expect(chunks).toHaveLength(0);
  });
});
