import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthContext } from "~/lib/auth/auth.server";
import { AuthorizationService } from "~/lib/auth/authorization-service.server";
import { QuotaService } from "~/lib/auth/quota-service.server";
import { TokenRepository } from "~/lib/auth/token-repository.server";
import { UserRepository } from "~/lib/auth/user-repository.server";
import type { DbClient } from "~/lib/db/client.server";
import { FileNodeRepository } from "~/lib/files/file-node-repository.server";
import { FileService } from "~/lib/files/file-service.server";
import { TrashRepository } from "~/lib/files/trash-repository.server";
import {
  type CreateSessionParams,
  UploadService,
} from "~/lib/files/upload-service.server";
import {
  expectedChunkCount,
  UploadSessionRepository,
} from "~/lib/files/upload-session-repository.server";
import { VersionRepository } from "~/lib/files/version-repository.server";
import { CHUNK_SIZE, ChunkedStorage } from "~/lib/storage/chunked.server";
import {
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  FINITE_TEST_LIMITS,
  type TestEnv,
} from "~/test/integration-helpers";

let testEnv: TestEnv;
let db: DbClient;
let userId: string;

function userAuth(uid?: string): AuthContext {
  return { type: "user", user_id: uid ?? userId };
}

function tokenAuthReadOnly(uid?: string): AuthContext {
  return {
    type: "token",
    user_id: uid ?? userId,
    token_id: "tok_readonly",
    base_path: "/",
    can_delegate: false,
    access_paths: [{ path: "", access: "read" }],
    resource: null,
  };
}

function tokenAuthScoped(uid?: string): AuthContext {
  return {
    type: "token",
    user_id: uid ?? userId,
    token_id: "tok_scoped",
    base_path: "/",
    can_delegate: false,
    access_paths: [{ path: "allowed", access: "write" }],
    resource: null,
  };
}

function buildService(forUserId?: string): UploadService {
  const containerUserId = forUserId ?? userId;
  const storage = testEnv.storage;
  const chunkedStorage = new ChunkedStorage(storage, containerUserId);
  const repo = new FileNodeRepository();
  const authz = new AuthorizationService();
  const quota = new QuotaService(
    new UserRepository(db),
    new TokenRepository(db),
  );
  const trashRepo = new TrashRepository();
  const versionRepo = new VersionRepository();
  const fileService = new FileService(
    db,
    containerUserId,
    chunkedStorage,
    repo,
    trashRepo,
    versionRepo,
    authz,
    quota,
  );
  const sessions = new UploadSessionRepository();

  return new UploadService(
    db,
    containerUserId,
    fileService,
    repo,
    sessions,
    quota,
    authz,
    storage,
  );
}

beforeAll(async () => {
  testEnv = await createTestEnv();
  db = testEnv.db;
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
  const user = await createTestUser(db);
  userId = user.id;
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe("createSession", () => {
  it("creates a session with valid params", async () => {
    const svc = buildService();
    const result = await svc.createSession(userAuth(), {
      rawPath: "docs/report.pdf",
      totalSize: 1024,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionId).toBeTruthy();
    expect(result.nodeId).toBeTruthy();
    expect(result.chunkSize).toBe(4194304);
    expect(result.expiresAt).toBeTruthy();
  });

  it("rejects empty segments (no path)", async () => {
    const svc = buildService();
    const result = await svc.createSession(userAuth(), {
      rawPath: "",
      totalSize: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("bad_request");
  });

  it("rejects root-only path", async () => {
    const svc = buildService();
    const result = await svc.createSession(userAuth(), {
      rawPath: "",
      totalSize: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("bad_request");
  });

  it("allows a valid path that happens to contain 'etc/passwd' as literal segments", async () => {
    const svc = buildService();
    const result = await svc.createSession(userAuth(), {
      rawPath: "docs/etc/passwd",
      totalSize: 10,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects path traversal with invalid_path", async () => {
    const svc = buildService();
    const result = await svc.createSession(userAuth(), {
      rawPath: "../etc/passwd",
      totalSize: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("bad_request");
  });

  it("rejects read-only token", async () => {
    const svc = buildService();
    const result = await svc.createSession(tokenAuthReadOnly(), {
      rawPath: "docs/file.txt",
      totalSize: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("forbidden");
  });

  it("rejects scoped token writing outside scope", async () => {
    const svc = buildService();
    const result = await svc.createSession(tokenAuthScoped(), {
      rawPath: "forbidden/file.txt",
      totalSize: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("forbidden");
  });

  it("allows scoped token writing inside scope", async () => {
    const svc = buildService();
    const result = await svc.createSession(tokenAuthScoped(), {
      rawPath: "allowed/file.txt",
      totalSize: 10,
    });
    expect(result.ok).toBe(true);
  });

  it("allows file-scope token writing the scoped file", async () => {
    const svc = buildService();
    const fileScoped: AuthContext = {
      type: "token",
      user_id: userId,
      token_id: "tok_file_scope",
      base_path: "/",
      can_delegate: false,
      access_paths: [{ path: "TASK.md", access: "write" }],
      resource: null,
    };
    const result = await svc.createSession(fileScoped, {
      rawPath: "TASK.md",
      totalSize: 10,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects file-scope token writing an adjacent file (boundary)", async () => {
    const svc = buildService();
    const fileScoped: AuthContext = {
      type: "token",
      user_id: userId,
      token_id: "tok_file_scope",
      base_path: "/",
      can_delegate: false,
      access_paths: [{ path: "TASK.md", access: "write" }],
      resource: null,
    };
    const result = await svc.createSession(fileScoped, {
      rawPath: "TASK.md.bak",
      totalSize: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("forbidden");
  });

  it("rejects when quota exceeded (pre-flight)", async () => {
    // Set a small storage limit with most storage used
    await db.execute(
      `UPDATE user_limits SET storage_limit_bytes = $2, grant_limit = $3, revision_limit = $4 WHERE user_id = $1`,
      [
        userId,
        FINITE_TEST_LIMITS.storage_limit_bytes,
        FINITE_TEST_LIMITS.grant_limit,
        FINITE_TEST_LIMITS.revision_limit,
      ],
    );
    await db.execute(
      "UPDATE user_storage SET bytes_used = $1 WHERE user_id = $2",
      [
        1024 * 1024 * 1024, // 1 GB (free limit)
        userId,
      ],
    );
    const svc = buildService();
    const result = await svc.createSession(userAuth(), {
      rawPath: "big-file.bin",
      totalSize: 1024, // even 1KB would exceed
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("quota_exceeded");
  });
});

// ---------------------------------------------------------------------------
// Full flow: create -> upload chunks -> complete
// ---------------------------------------------------------------------------

describe("full upload flow", () => {
  it("creates session, uploads chunks, and completes", async () => {
    const svc = buildService();

    // Create session
    const createResult = await svc.createSession(userAuth(), {
      rawPath: "docs/test.bin",
      totalSize: 10,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // Upload chunk
    const data = new TextEncoder().encode("0123456789").buffer as ArrayBuffer;
    const chunkResult = await svc.uploadChunk(
      userAuth(),
      createResult.sessionId,
      0,
      data,
    );
    expect(chunkResult.ok).toBe(true);
    if (!chunkResult.ok) return;
    expect(chunkResult.size).toBe(10);
    expect(chunkResult.checksum).toBeTruthy();

    // Complete
    const completeResult = await svc.completeSession(
      userAuth(),
      createResult.sessionId,
    );
    expect(completeResult.ok).toBe(true);
    if (!completeResult.ok) return;
    expect(completeResult.nodeId).toBe(createResult.nodeId);
    expect(completeResult.size).toBe(10);
    expect(completeResult.chunkCount).toBe(1);
    expect(completeResult.contentVersion).toBeGreaterThanOrEqual(1);
  });

  it("handles multi-chunk upload", async () => {
    const svc = buildService();
    const totalSize = CHUNK_SIZE * 3;

    const createResult = await svc.createSession(userAuth(), {
      rawPath: "multi.bin",
      totalSize,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // Upload 3 chunks: first two exactly CHUNK_SIZE, last one CHUNK_SIZE
    for (let i = 0; i < 3; i++) {
      const data = new ArrayBuffer(CHUNK_SIZE);
      const r = await svc.uploadChunk(
        userAuth(),
        createResult.sessionId,
        i,
        data,
      );
      expect(r.ok).toBe(true);
    }

    const completeResult = await svc.completeSession(
      userAuth(),
      createResult.sessionId,
    );
    expect(completeResult.ok).toBe(true);
    if (!completeResult.ok) return;
    expect(completeResult.chunkCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Cancel flow
// ---------------------------------------------------------------------------

describe("cancelSession", () => {
  it("cancels an active session", async () => {
    const svc = buildService();

    const createResult = await svc.createSession(userAuth(), {
      rawPath: "to-cancel.bin",
      totalSize: 10,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // Upload a chunk first
    const data = new TextEncoder().encode("data").buffer as ArrayBuffer;
    await svc.uploadChunk(userAuth(), createResult.sessionId, 0, data);

    const cancelResult = await svc.cancelSession(
      userAuth(),
      createResult.sessionId,
    );
    expect(cancelResult.ok).toBe(true);

    // Verify session is gone (uploading to it should fail)
    const uploadAfterCancel = await svc.uploadChunk(
      userAuth(),
      createResult.sessionId,
      1,
      data,
    );
    expect(uploadAfterCancel.ok).toBe(false);
    if (!uploadAfterCancel.ok) {
      expect(uploadAfterCancel.code).toBe("not_found");
    }
  });

  it("rejects canceling a completed session", async () => {
    const svc = buildService();

    // Create and complete a session
    const createResult = await svc.createSession(userAuth(), {
      rawPath: "completed.bin",
      totalSize: 7,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const data = new TextEncoder().encode("content").buffer as ArrayBuffer;
    await svc.uploadChunk(userAuth(), createResult.sessionId, 0, data);
    await svc.completeSession(userAuth(), createResult.sessionId);

    const cancelResult = await svc.cancelSession(
      userAuth(),
      createResult.sessionId,
    );
    expect(cancelResult.ok).toBe(false);
    if (!cancelResult.ok) {
      expect(cancelResult.code).toBe("conflict");
    }
  });

  it("returns not_found for nonexistent session", async () => {
    const svc = buildService();
    const result = await svc.cancelSession(userAuth(), "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_found");
    }
  });
});

// ---------------------------------------------------------------------------
// State machine enforcement
// ---------------------------------------------------------------------------

describe("session state machine", () => {
  it("cannot complete a session twice", async () => {
    const svc = buildService();

    const createResult = await svc.createSession(userAuth(), {
      rawPath: "double-complete.bin",
      totalSize: 4,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const data = new TextEncoder().encode("data").buffer as ArrayBuffer;
    await svc.uploadChunk(userAuth(), createResult.sessionId, 0, data);

    const first = await svc.completeSession(userAuth(), createResult.sessionId);
    expect(first.ok).toBe(true);

    const second = await svc.completeSession(
      userAuth(),
      createResult.sessionId,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("conflict");
    }
  });

  it("cannot upload to a completed session", async () => {
    const svc = buildService();

    const createResult = await svc.createSession(userAuth(), {
      rawPath: "no-upload-after-complete.bin",
      totalSize: 4,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const data = new TextEncoder().encode("data").buffer as ArrayBuffer;
    await svc.uploadChunk(userAuth(), createResult.sessionId, 0, data);
    await svc.completeSession(userAuth(), createResult.sessionId);

    const result = await svc.uploadChunk(
      userAuth(),
      createResult.sessionId,
      1,
      data,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("conflict");
    }
  });

  it("cannot complete with no chunks", async () => {
    const svc = buildService();

    const createResult = await svc.createSession(userAuth(), {
      rawPath: "empty.bin",
      totalSize: 10,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const result = await svc.completeSession(
      userAuth(),
      createResult.sessionId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("bad_request");
      expect(result.message).toContain("No chunks");
    }
  });

  it("cannot complete with missing chunks (gap)", async () => {
    const svc = buildService();
    // totalSize requires 3 chunks so we can upload chunk 0 and 2, skipping 1
    const totalSize = CHUNK_SIZE * 3;

    const createResult = await svc.createSession(userAuth(), {
      rawPath: "gap.bin",
      totalSize,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // Upload chunk 0 and chunk 2 (skip 1) — first two must be CHUNK_SIZE
    const fullChunk = new ArrayBuffer(CHUNK_SIZE);
    await svc.uploadChunk(userAuth(), createResult.sessionId, 0, fullChunk);
    await svc.uploadChunk(userAuth(), createResult.sessionId, 2, fullChunk);

    const result = await svc.completeSession(
      userAuth(),
      createResult.sessionId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("bad_request");
      expect(result.message).toContain("Missing chunk");
    }
  });

  it("rejects completing with fewer chunks than expected", async () => {
    const svc = buildService();
    // totalSize expects 3 chunks, but we only upload 1
    const totalSize = CHUNK_SIZE * 3;

    const createResult = await svc.createSession(userAuth(), {
      rawPath: "wrong-count.bin",
      totalSize,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const data = new ArrayBuffer(CHUNK_SIZE);
    await svc.uploadChunk(userAuth(), createResult.sessionId, 0, data);

    const result = await svc.completeSession(
      userAuth(),
      createResult.sessionId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("bad_request");
      expect(result.message).toContain(
        `Expected ${expectedChunkCount(totalSize)} chunks`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Tx rollback on conflict
// ---------------------------------------------------------------------------

describe("completeSession rollback", () => {
  it("marks session 'failed' under app role on commitRevision conflict", async () => {
    // The failed-mark must run inside withUserWriteTx so the
    // RLS UPDATE finds `app.user_id`. Run the whole flow under SET ROLE app
    // (NOBYPASSRLS) so a regression that drops the tx wrapper is caught here
    // — superuser BYPASSRLS would silently let the bare UPDATE succeed.
    const svc = buildService();

    const createResult = await svc.createSession(userAuth(), {
      rawPath: "rollback-test.bin",
      totalSize: 4,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const data = new TextEncoder().encode("data").buffer as ArrayBuffer;
    await svc.uploadChunk(userAuth(), createResult.sessionId, 0, data);

    // Bump content_version to force CAS conflict in commitRevision (option b
    // from Codex review — deterministic, exercises the real rollback path).
    const nodeId = createResult.nodeId;
    await db.execute(
      "UPDATE file_nodes SET content_version = 999 WHERE id = $1",
      [nodeId],
    );

    await db.execute("SET row_security = on");
    await db.execute("SET ROLE app");
    let result: Awaited<ReturnType<typeof svc.completeSession>>;
    try {
      result = await svc.completeSession(userAuth(), createResult.sessionId);
    } finally {
      await db.execute("RESET ROLE");
      await db.execute("RESET row_security");
    }
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("conflict");
    }

    const session = await db.queryOne<{ status: string }>(
      "SELECT status FROM upload_sessions WHERE id = $1",
      [createResult.sessionId],
    );
    expect(session?.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Quota enforcement on complete
// ---------------------------------------------------------------------------

describe("quota enforcement", () => {
  it("rejects completion when quota exceeded", async () => {
    const svc = buildService();

    // Create and upload
    const createResult = await svc.createSession(userAuth(), {
      rawPath: "quota-file.bin",
      totalSize: 24,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const data = new TextEncoder().encode("some data for quota test")
      .buffer as ArrayBuffer;
    await svc.uploadChunk(userAuth(), createResult.sessionId, 0, data);

    // Now exhaust the quota (set to the storage limit)
    await db.execute(
      `UPDATE user_limits SET storage_limit_bytes = $2, grant_limit = $3, revision_limit = $4 WHERE user_id = $1`,
      [
        userId,
        FINITE_TEST_LIMITS.storage_limit_bytes,
        FINITE_TEST_LIMITS.grant_limit,
        FINITE_TEST_LIMITS.revision_limit,
      ],
    );
    await db.execute(
      "UPDATE user_storage SET bytes_used = $1 WHERE user_id = $2",
      [1024 * 1024 * 1024, userId],
    );

    const result = await svc.completeSession(
      userAuth(),
      createResult.sessionId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("quota_exceeded");
    }
  });
});

// ---------------------------------------------------------------------------
// Upload session hardening
// ---------------------------------------------------------------------------

describe("upload session hardening", () => {
  it("rejects createSession without totalSize", async () => {
    const svc = buildService();
    const result = await svc.createSession(userAuth(), {
      rawPath: "test.bin",
      totalSize: 0,
    } as CreateSessionParams);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("bad_request");
  });

  it("rejects negative totalSize", async () => {
    const svc = buildService();
    const result = await svc.createSession(userAuth(), {
      rawPath: "test.bin",
      totalSize: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("bad_request");
  });

  it("rejects chunkIndex exceeding expected count", async () => {
    const svc = buildService();
    const createResult = await svc.createSession(userAuth(), {
      rawPath: "small.bin",
      totalSize: 10,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // totalSize=10, chunkSize=4MB → expectedChunks=1, so chunkIndex=1 should fail
    const data = new TextEncoder().encode("0123456789").buffer as ArrayBuffer;
    const result = await svc.uploadChunk(
      userAuth(),
      createResult.sessionId,
      1,
      data,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("too_large");
  });

  it("rejects chunk when cumulative size exceeds totalSize", async () => {
    const svc = buildService();
    const createResult = await svc.createSession(userAuth(), {
      rawPath: "overflow.bin",
      totalSize: 5,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // Send 10 bytes when totalSize=5
    const data = new TextEncoder().encode("0123456789").buffer as ArrayBuffer;
    const result = await svc.uploadChunk(
      userAuth(),
      createResult.sessionId,
      0,
      data,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("too_large");
  });

  it("cancel uses CAS — cannot cancel completed session", async () => {
    const svc = buildService();
    const createResult = await svc.createSession(userAuth(), {
      rawPath: "cas-cancel.bin",
      totalSize: 4,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const data = new TextEncoder().encode("data").buffer as ArrayBuffer;
    await svc.uploadChunk(userAuth(), createResult.sessionId, 0, data);
    await svc.completeSession(userAuth(), createResult.sessionId);

    const result = await svc.cancelSession(userAuth(), createResult.sessionId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("conflict");
  });
});

// ---------------------------------------------------------------------------
// Cross-user authorization
//
// User B must not be able to operate on User A's session even when guessing
// a valid sessionId. UploadService scopes session lookups by user_id, so all
// such attempts must return not_found and have zero side effects on A.
// ---------------------------------------------------------------------------

describe("cross-user session isolation", () => {
  it("uploadChunk(authB, sessionA) returns not_found and leaves A's session + chunks intact", async () => {
    // Seed user B in addition to user A (already created by beforeEach as `userId`).
    const userA = userId;
    const userB = (await createTestUser(db)).id;

    const svcA = buildService(userA);

    // A creates a session and uploads chunk 0
    const create = await svcA.createSession(
      { type: "user", user_id: userA },
      { rawPath: "cross/a-file.bin", totalSize: 10 },
    );
    expect(create.ok).toBe(true);
    if (!create.ok) return;

    const dataA = new TextEncoder().encode("0123456789").buffer as ArrayBuffer;
    const chunkA = await svcA.uploadChunk(
      { type: "user", user_id: userA },
      create.sessionId,
      0,
      dataA,
    );
    expect(chunkA.ok).toBe(true);

    // Snapshot A's state
    const sessionBefore = await db.queryOne<{
      status: string;
      user_id: string;
    }>("SELECT status, user_id FROM upload_sessions WHERE id = $1", [
      create.sessionId,
    ]);
    expect(sessionBefore?.status).toBe("active");
    expect(sessionBefore?.user_id).toBe(userA);
    const chunksBefore = await db.query<{
      chunk_index: number;
      size: number;
      checksum: string;
    }>(
      "SELECT chunk_index, size, checksum FROM upload_session_chunks WHERE session_id = $1 ORDER BY chunk_index",
      [create.sessionId],
    );
    expect(chunksBefore.length).toBe(1);

    // B attempts to upload to A's session
    const svcB = buildService(userB);
    const dataB = new TextEncoder().encode("BBBBBBBBBB").buffer as ArrayBuffer;
    const attempt = await svcB.uploadChunk(
      { type: "user", user_id: userB },
      create.sessionId,
      1,
      dataB,
    );
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.code).toBe("not_found");

    // A's session must still be active and untouched
    const sessionAfter = await db.queryOne<{ status: string; user_id: string }>(
      "SELECT status, user_id FROM upload_sessions WHERE id = $1",
      [create.sessionId],
    );
    expect(sessionAfter?.status).toBe("active");
    expect(sessionAfter?.user_id).toBe(userA);

    // A's chunks must be unchanged (no new chunk recorded, existing chunk byte-identical)
    const chunksAfter = await db.query<{
      chunk_index: number;
      size: number;
      checksum: string;
    }>(
      "SELECT chunk_index, size, checksum FROM upload_session_chunks WHERE session_id = $1 ORDER BY chunk_index",
      [create.sessionId],
    );
    expect(chunksAfter).toEqual(chunksBefore);
  });

  it("completeSession(authB, sessionA) returns not_found and leaves A's session active + file_node untouched", async () => {
    const userA = userId;
    const userB = (await createTestUser(db)).id;

    const svcA = buildService(userA);

    const create = await svcA.createSession(
      { type: "user", user_id: userA },
      { rawPath: "cross/complete-target.bin", totalSize: 4 },
    );
    expect(create.ok).toBe(true);
    if (!create.ok) return;

    const data = new TextEncoder().encode("data").buffer as ArrayBuffer;
    const chunkResult = await svcA.uploadChunk(
      { type: "user", user_id: userA },
      create.sessionId,
      0,
      data,
    );
    expect(chunkResult.ok).toBe(true);

    // Snapshot file_node state BEFORE the cross-user attempt
    const nodeBefore = await db.queryOne<{
      content_version: number;
      cached_size: number | null;
      user_id: string;
    }>(
      "SELECT content_version, cached_size, user_id FROM file_nodes WHERE id = $1",
      [create.nodeId],
    );
    expect(nodeBefore?.user_id).toBe(userA);

    // B attempts to complete A's session
    const svcB = buildService(userB);
    const attempt = await svcB.completeSession(
      { type: "user", user_id: userB },
      create.sessionId,
    );
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.code).toBe("not_found");

    // A's session must still be active (not completed/failed)
    const sessionAfter = await db.queryOne<{ status: string }>(
      "SELECT status FROM upload_sessions WHERE id = $1",
      [create.sessionId],
    );
    expect(sessionAfter?.status).toBe("active");

    // A's file_node must not have been mutated (no commitRevision side effect)
    const nodeAfter = await db.queryOne<{
      content_version: number;
      cached_size: number | null;
      user_id: string;
    }>(
      "SELECT content_version, cached_size, user_id FROM file_nodes WHERE id = $1",
      [create.nodeId],
    );
    expect(nodeAfter).toEqual(nodeBefore);

    // No file_revisions row should have been written for this session/node
    const revisions = await db.query<{ id: string }>(
      "SELECT id FROM file_revisions WHERE node_id = $1",
      [create.nodeId],
    );
    expect(revisions.length).toBe(0);

    // A can still complete their own session normally afterwards
    const ownComplete = await svcA.completeSession(
      { type: "user", user_id: userA },
      create.sessionId,
    );
    expect(ownComplete.ok).toBe(true);
  });

  it("cancelSession(authB, sessionA) returns not_found and leaves A's session active", async () => {
    const userA = userId;
    const userB = (await createTestUser(db)).id;

    const svcA = buildService(userA);

    const create = await svcA.createSession(
      { type: "user", user_id: userA },
      { rawPath: "cross/cancel-target.bin", totalSize: 4 },
    );
    expect(create.ok).toBe(true);
    if (!create.ok) return;

    const data = new TextEncoder().encode("data").buffer as ArrayBuffer;
    await svcA.uploadChunk(
      { type: "user", user_id: userA },
      create.sessionId,
      0,
      data,
    );

    // B attempts to cancel A's session
    const svcB = buildService(userB);
    const attempt = await svcB.cancelSession(
      { type: "user", user_id: userB },
      create.sessionId,
    );
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.code).toBe("not_found");

    // A's session must still be active and not deleted
    const sessionAfter = await db.queryOne<{ status: string }>(
      "SELECT status FROM upload_sessions WHERE id = $1",
      [create.sessionId],
    );
    expect(sessionAfter?.status).toBe("active");

    // A's chunks must still exist
    const chunksAfter = await db.query<{ chunk_index: number }>(
      "SELECT chunk_index FROM upload_session_chunks WHERE session_id = $1",
      [create.sessionId],
    );
    expect(chunksAfter.length).toBe(1);

    // A can still cancel their own session afterwards
    const ownCancel = await svcA.cancelSession(
      { type: "user", user_id: userA },
      create.sessionId,
    );
    expect(ownCancel.ok).toBe(true);
  });
});
