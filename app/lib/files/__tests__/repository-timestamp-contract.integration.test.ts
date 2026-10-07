// Repository contract test: timestamp fields are returned as ISO 8601 strings.
//
// pg returns TIMESTAMP / TIMESTAMPTZ as Date by default. The files-side
// repositories declare these columns as `string` in their domain types and
// must coerce at the row mapper. This test guards against regressions where
// a Date leaks through to the service / gateway layer.
//
// See docs/s2.md for the layering rule.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "~/lib/db/client.server";
import { FileNodeRepository } from "~/lib/files/file-node-repository.server";
import { UploadSessionRepository } from "~/lib/files/upload-session-repository.server";
import { VersionRepository } from "~/lib/files/version-repository.server";
import {
  asTestTx,
  FINITE_TEST_LIMITS,
  seedTestUser,
} from "~/test/integration-helpers";
import { createTestDb } from "~/test/test-db";

const USER = "user_ts_contract";

let db: DbClient;
let nodes: FileNodeRepository;
let uploads: UploadSessionRepository;
let versions: VersionRepository;
let tx: ReturnType<typeof asTestTx>;

beforeAll(async () => {
  db = await createTestDb();
  tx = asTestTx(db);
});

beforeEach(async () => {
  await db.execute("DELETE FROM upload_session_chunks");
  await db.execute("DELETE FROM upload_sessions");
  await db.execute("DELETE FROM file_revisions");
  await db.execute("DELETE FROM file_nodes");
  await db.execute(`DELETE FROM "user"`);
  await seedTestUser(db, {
    id: USER,
    email: "ts@test.com",
    limits: FINITE_TEST_LIMITS,
    bytesUsed: 0,
  });
  nodes = new FileNodeRepository();
  uploads = new UploadSessionRepository();
  versions = new VersionRepository();
});

const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

describe("repository timestamp contract", () => {
  it("FileNodeRepository.getNode returns ISO 8601 strings", async () => {
    const created = await nodes.createNode(
      {
        userId: USER,
        parentId: "",
        name: "f.txt",
        isDirectory: false,
        contentType: "text/plain",
      },
      tx,
    );
    const node = await nodes.getNode(USER, created.id, tx);
    expect(node).not.toBeNull();
    expect(typeof node?.createdAt).toBe("string");
    expect(node?.createdAt).toMatch(ISO_8601_UTC);
    expect(
      node?.updatedAt === null || typeof node?.updatedAt === "string",
    ).toBe(true);
    expect(
      node?.deletedAt === null || typeof node?.deletedAt === "string",
    ).toBe(true);
  });

  it("VersionRepository.listRevisions returns ISO 8601 strings", async () => {
    const created = await nodes.createNode(
      {
        userId: USER,
        parentId: "",
        name: "v.txt",
        isDirectory: false,
        contentType: "text/plain",
      },
      tx,
    );
    // Manually insert a revision row (FileService normally does this
    // through commitRevision; we bypass it here to keep the test focused).
    const revId = `rev_${Date.now()}`;
    await db.execute(
      `INSERT INTO file_revisions
         (id, node_id, user_id, storage_prefix, content_type, chunk_count, size, hash)
       SELECT $1, id, user_id, 'p', 'text/plain', 1, 1, $3 FROM file_nodes WHERE id = $2`,
      [revId, created.id, `test-hash-${revId}`],
    );
    const revs = await versions.listRevisions(created.id, tx);
    expect(revs.length).toBeGreaterThan(0);
    for (const r of revs) {
      expect(typeof r.createdAt).toBe("string");
      expect(r.createdAt).toMatch(ISO_8601_UTC);
    }
  });

  it("UploadSessionRepository.create returns ISO 8601 strings", async () => {
    const node = await nodes.createNode(
      {
        userId: USER,
        parentId: "",
        name: "u.bin",
        isDirectory: false,
        contentType: "x/y",
      },
      tx,
    );
    const session = await uploads.create(
      USER,
      node.id,
      0,
      "rev_x",
      1024,
      asTestTx(db),
    );
    expect(typeof session.createdAt).toBe("string");
    expect(session.createdAt).toMatch(ISO_8601_UTC);
    expect(typeof session.expiresAt).toBe("string");
    expect(session.expiresAt).toMatch(ISO_8601_UTC);
  });
});
