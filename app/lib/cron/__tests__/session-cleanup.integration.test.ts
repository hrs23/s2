import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "~/lib/db/client.server";
import { UploadSessionRepository } from "~/lib/files/upload-session-repository.server";
import { asTestTx, seedTestUser } from "~/test/integration-helpers";
import { createTestDb } from "~/test/test-db";
import { runSessionCleanup } from "../session-cleanup.server";

let tx: ReturnType<typeof asTestTx>;
// session-cleanup no longer touches object storage. Expired sessions are
// removed from the DB and their storage prefix is enqueued in
// storage_tombstones for the GC worker to reap.

const USER = "user_cron_session_001";

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

async function createExpiredSession(
  repo: UploadSessionRepository,
  revisionId: string,
  status: "active" | "failed" = "active",
) {
  const session = await repo.create(
    USER,
    "node1",
    0,
    revisionId,
    1024,
    asTestTx(db),
  );
  await db.execute(
    "UPDATE upload_sessions SET expires_at = $1, status = $2 WHERE id = $3",
    [new Date(Date.now() - 60_000).toISOString(), status, session.id],
  );
  return session;
}

function sessionPrefix(sessionId: string) {
  return `${USER}/node1/u/${sessionId}`;
}

beforeEach(async () => {
  await db.execute("DELETE FROM storage_tombstones");
  await db.execute("DELETE FROM upload_session_chunks");
  await db.execute("DELETE FROM upload_sessions");
  await db.execute("DELETE FROM file_nodes");
  await db.execute(`DELETE FROM "user"`);
  await seedTestUser(db, { id: USER, email: `${USER}@test.local` });
  await db.execute(
    `INSERT INTO file_nodes (id, user_id, parent_id, name, content_type, is_directory, content_version, created_at)
     VALUES ($1,$2,NULLIF($3, ''),$4,$5,$6,$7,$8)`,
    [
      "node1",
      USER,
      "",
      "test.bin",
      "application/octet-stream",
      false,
      0,
      new Date().toISOString(),
    ],
  );
});

describe("runSessionCleanup", () => {
  it("removes expired active sessions and enqueues a tombstone for the prefix", async () => {
    const repo = new UploadSessionRepository();
    const session = await createExpiredSession(repo, "rev1");
    await repo.recordChunk(session.id, 0, 512, "checksum0", asTestTx(db));
    const prefix = sessionPrefix(session.id);

    const result = await runSessionCleanup(makeEnv());

    expect(result).toMatchObject({ expired: 1, deleted: 1, usersFailed: 0 });
    expect(await repo.get(USER, session.id, tx)).toBeNull();

    const tombstones = await db.query<{ storage_prefix: string }>(
      "SELECT storage_prefix FROM storage_tombstones",
    );
    expect(tombstones.map((t) => t.storage_prefix)).toEqual([prefix]);
  });

  it("removes expired failed sessions", async () => {
    const repo = new UploadSessionRepository();
    const session = await createExpiredSession(repo, "rev2", "failed");
    const prefix = sessionPrefix(session.id);

    const result = await runSessionCleanup(makeEnv());

    expect(result).toMatchObject({ expired: 1, deleted: 1, usersFailed: 0 });
    const tombstones = await db.query<{ storage_prefix: string }>(
      "SELECT storage_prefix FROM storage_tombstones",
    );
    expect(tombstones.map((t) => t.storage_prefix)).toEqual([prefix]);
  });

  it("skips non-expired sessions", async () => {
    const repo = new UploadSessionRepository();
    await repo.create(USER, "node1", 0, "rev3", 1024, asTestTx(db));

    const result = await runSessionCleanup(makeEnv());

    expect(result).toMatchObject({ expired: 0, deleted: 0, usersFailed: 0 });
    const tombstones = await db.query("SELECT 1 FROM storage_tombstones");
    expect(tombstones).toHaveLength(0);
  });

  it("skips completed sessions (commit already created file_revisions)", async () => {
    const repo = new UploadSessionRepository();
    const session = await repo.create(
      USER,
      "node1",
      0,
      "rev4",
      1024,
      asTestTx(db),
    );
    await db.execute(
      "UPDATE upload_sessions SET expires_at = $1, status = 'completed' WHERE id = $2",
      [new Date(Date.now() - 60_000).toISOString(), session.id],
    );

    const result = await runSessionCleanup(makeEnv());

    expect(result).toMatchObject({ expired: 0, deleted: 0, usersFailed: 0 });
    expect(await repo.get(USER, session.id, tx)).not.toBeNull();
  });
});
