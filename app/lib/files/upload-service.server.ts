// UploadService: service-layer for chunked upload sessions.
// Centralizes authorization, quota, and state-machine logic.

import { assertServiceUserMatches } from "~/lib/auth/auth-assertions.server";
import type { IAuthorizationService } from "~/lib/auth/authorization-service.server";
import type { IQuotaService } from "~/lib/auth/quota-service.server";
import type { AuthContext } from "~/lib/auth/types";
import { enqueueStorageTombstone } from "~/lib/cron/storage-gc.server";
import { sha256Hex } from "~/lib/crypto/hash.server";
import type { DbClient } from "~/lib/db/client.server";
import { TxRollbackError } from "~/lib/db/tx-error";
import { logError, logWarn } from "~/lib/observability/logger.server";
import type { StorageAdapter } from "~/lib/storage/adapter";
import { sessionStoragePrefix } from "~/lib/storage/chunked.server";
import { generateUlidForApi } from "~/lib/utils/ulid.server";
import type { FileNodeRepository } from "./file-node-repository.server";
import type { FileService } from "./file-service.server";
import { parseClientPath } from "./paths";
import {
  CHUNK_SIZE,
  expectedChunkCount,
  type UploadSessionRepository,
} from "./upload-session-repository.server";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type UploadResult<T, E extends string> =
  | (T & { ok: true })
  | { ok: false; code: E; message: string };

const SESSION_NOT_FOUND_ERROR = {
  ok: false,
  code: "not_found",
  message: "Session not found",
} as const;

export interface CreateSessionParams {
  rawPath: string;
  totalSize: number;
}

export interface CreateSessionResult {
  sessionId: string;
  nodeId: string;
  chunkSize: number;
  expiresAt: string;
}

export interface UploadChunkResult {
  chunkIndex: number;
  size: number;
  checksum: string;
}

export interface CompleteSessionResult {
  nodeId: string;
  size: number;
  chunkCount: number;
  contentVersion: number;
}

// ---------------------------------------------------------------------------
// UploadService
// ---------------------------------------------------------------------------

export class UploadService {
  constructor(
    private db: DbClient,
    private userId: string,
    private fileService: FileService,
    private repo: FileNodeRepository,
    private sessions: UploadSessionRepository,
    private quota: IQuotaService,
    private authz: IAuthorizationService,
    private rawStorage: StorageAdapter,
  ) {}

  // ---- createSession --------------------------------------------------------

  async createSession(
    auth: AuthContext,
    params: CreateSessionParams,
  ): Promise<
    UploadResult<
      CreateSessionResult,
      "bad_request" | "forbidden" | "quota_exceeded"
    >
  > {
    assertServiceUserMatches(auth, this.userId);
    if (!params.rawPath || !params.rawPath.replace(/^\/+/, "")) {
      return {
        ok: false,
        code: "bad_request",
        message: "path must point to a file",
      };
    }
    if (
      typeof params.totalSize !== "number" ||
      !Number.isInteger(params.totalSize) ||
      params.totalSize <= 0
    ) {
      return {
        ok: false,
        code: "bad_request",
        message: "totalSize must be a positive integer",
      };
    }

    const parsed = parseClientPath(params.rawPath, auth);
    if (!parsed.ok)
      return { ok: false, code: "bad_request", message: parsed.error };
    const segments = parsed.segments;

    // Authorization: check write permission on the full absolute path
    const filePath = `/${segments.join("/")}`;
    if (!this.authz.checkAbsolutePath(auth, filePath, "write")) {
      return { ok: false, code: "forbidden", message: "Forbidden" };
    }

    // Pre-generate revision_id for the commit path
    const revisionId = generateUlidForApi();

    const result = await this.db.withUserWriteTx(this.userId, async (tx) => {
      // Pre-flight quota check inside the user-scoped tx so user_limits /
      // user_storage reads obey RLS.
      const check = await this.quota.checkStorage(
        auth.user_id,
        params.totalSize,
        tx,
      );
      if (!check.allowed) {
        return { ok: false as const };
      }

      // Resolve or create the target file node
      const { nodeId } = await this.repo.resolveOrCreate(
        {
          userId: auth.user_id,
          segments,
          isDirectory: false,
          contentType: "application/octet-stream",
        },
        tx,
      );

      const node = await this.repo.getNode(auth.user_id, nodeId, tx);
      const baseContentVersion = node?.contentVersion ?? 0;

      const session = await this.sessions.create(
        auth.user_id,
        nodeId,
        baseContentVersion,
        revisionId,
        params.totalSize,
        tx,
      );
      return { ok: true as const, nodeId, session };
    });

    if (!result.ok) {
      return {
        ok: false,
        code: "quota_exceeded",
        message: "Storage limit exceeded.",
      };
    }
    const { nodeId, session } = result;

    return {
      ok: true,
      sessionId: session.id,
      nodeId,
      chunkSize: session.chunkSize,
      expiresAt: session.expiresAt,
    };
  }

  // ---- uploadChunk ----------------------------------------------------------

  async uploadChunk(
    auth: AuthContext,
    sessionId: string,
    chunkIndex: number,
    data: ArrayBuffer,
  ): Promise<
    UploadResult<
      UploadChunkResult,
      "bad_request" | "not_found" | "conflict" | "expired" | "too_large"
    >
  > {
    assertServiceUserMatches(auth, this.userId);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return {
        ok: false,
        code: "bad_request",
        message: "Invalid chunk index",
      };
    }

    const preflight = await this.db.withUserWriteTx(this.userId, async (tx) => {
      const session = await this.sessions.get(auth.user_id, sessionId, tx);
      if (!session) {
        return SESSION_NOT_FOUND_ERROR;
      }
      if (session.status !== "active") {
        return {
          ok: false as const,
          code: "conflict" as const,
          message: `Session is ${session.status}`,
        };
      }
      if (new Date(session.expiresAt) < new Date()) {
        await this.sessions.setStatus(sessionId, "failed", undefined, tx);
        return {
          ok: false as const,
          code: "expired" as const,
          message: "Session expired",
        };
      }

      // --- Chunk validation ---

      const maxChunks = expectedChunkCount(
        session.totalSize,
        session.chunkSize,
      );

      // chunkIndex upper bound
      if (chunkIndex >= maxChunks) {
        return {
          ok: false as const,
          code: "too_large" as const,
          message: `Chunk index ${chunkIndex} exceeds maximum ${maxChunks - 1}`,
        };
      }

      if (data.byteLength === 0) {
        return {
          ok: false as const,
          code: "bad_request" as const,
          message: "Empty chunk",
        };
      }

      // Chunk size enforcement: non-final chunks must be exactly chunkSize
      const isLastChunk = chunkIndex === maxChunks - 1;
      if (isLastChunk) {
        if (data.byteLength > CHUNK_SIZE) {
          return {
            ok: false as const,
            code: "too_large" as const,
            message: `Chunk exceeds maximum size of ${CHUNK_SIZE} bytes`,
          };
        }
      } else {
        if (data.byteLength !== CHUNK_SIZE) {
          return {
            ok: false as const,
            code: "bad_request" as const,
            message: `Non-final chunk must be exactly ${CHUNK_SIZE} bytes, got ${data.byteLength}`,
          };
        }
      }

      // Cumulative size check (delta-aware for re-uploads)
      const { totalUploaded, existingChunkSize } =
        await this.sessions.getUploadedSize(sessionId, chunkIndex, tx);
      const delta = data.byteLength - existingChunkSize;
      if (totalUploaded + delta > session.totalSize) {
        return {
          ok: false as const,
          code: "too_large" as const,
          message: "Cumulative upload size would exceed totalSize",
        };
      }

      return { ok: true as const, session };
    });

    if (!preflight.ok) return preflight;
    const { session } = preflight;

    // --- Storage write (storage first, DB after) ---

    const checksum = await sha256Hex(data);

    const storagePrefix = sessionStoragePrefix(
      auth.user_id,
      session.nodeId,
      session.id,
    );
    const r2Key = `${storagePrefix}/c/${String(chunkIndex).padStart(5, "0")}`;
    await this.rawStorage.put(r2Key, data);

    // Record in DB under row lock to serialise with completeSession.
    // If completeSession already flipped status to 'completed', the chunk
    // record is not written and the storage object is cleaned up.
    try {
      await this.db.withUserWriteTx(this.userId, async (tx) => {
        const row = await tx.queryOne<{ status: string }>(
          "SELECT status FROM upload_sessions WHERE id = $1 FOR UPDATE",
          [sessionId],
        );
        if (row?.status !== "active") {
          throw new UploadSessionNotActiveError(row?.status ?? "unknown");
        }
        await this.sessions.recordChunk(
          sessionId,
          chunkIndex,
          data.byteLength,
          checksum,
          tx,
        );
      });
    } catch (e) {
      if (e instanceof UploadSessionNotActiveError) {
        // Do not delete the chunk directly. The session prefix is shared with
        // already-committed chunks (commitSession reuses session.id as the
        // prefix attempt segment), so tombstoning the whole prefix would also
        // reap live chunks. A single-chunk leak is accepted in this race.
        logWarn(
          "upload_service",
          "stale_chunk_leak",
          { r2Key, sessionStatus: e.status },
          new Error("stale chunk after session no longer active"),
        );
        return {
          ok: false,
          code: "conflict" as const,
          message: `Session is ${e.status}`,
        };
      }
      throw e;
    }

    return {
      ok: true,
      chunkIndex,
      size: data.byteLength,
      checksum,
    };
  }

  // ---- completeSession ------------------------------------------------------

  async completeSession(
    auth: AuthContext,
    sessionId: string,
  ): Promise<
    UploadResult<
      CompleteSessionResult,
      "bad_request" | "not_found" | "conflict" | "expired" | "quota_exceeded"
    >
  > {
    assertServiceUserMatches(auth, this.userId);
    const preflight = await this.db.withUserWriteTx(this.userId, async (tx) => {
      const session = await this.sessions.get(auth.user_id, sessionId, tx);
      if (!session) {
        return SESSION_NOT_FOUND_ERROR;
      }
      if (session.status !== "active") {
        return {
          ok: false as const,
          code: "conflict" as const,
          message: `Session is ${session.status}`,
        };
      }
      if (new Date(session.expiresAt) < new Date()) {
        await this.sessions.setStatus(sessionId, "failed", "active", tx);
        return {
          ok: false as const,
          code: "expired" as const,
          message: "Session expired",
        };
      }

      const chunks = await this.sessions.getChunks(sessionId, tx);
      if (chunks.length === 0) {
        return {
          ok: false as const,
          code: "bad_request" as const,
          message: "No chunks uploaded",
        };
      }

      // Validate: chunks must be contiguous starting from 0
      for (let i = 0; i < chunks.length; i++) {
        if (chunks[i].chunkIndex !== i) {
          return {
            ok: false as const,
            code: "bad_request" as const,
            message: `Missing chunk ${i}`,
          };
        }
      }

      const maxChunks = expectedChunkCount(
        session.totalSize,
        session.chunkSize,
      );
      if (chunks.length !== maxChunks) {
        return {
          ok: false as const,
          code: "bad_request" as const,
          message: `Expected ${maxChunks} chunks, got ${chunks.length}`,
        };
      }

      const totalSize = chunks.reduce((s, c) => s + c.size, 0);

      if (totalSize !== session.totalSize) {
        return {
          ok: false as const,
          code: "bad_request" as const,
          message: `Expected total size ${session.totalSize}, got ${totalSize}`,
        };
      }

      // Pre-flight quota check (full new_size). Inside this tx so
      // user_limits / user_storage reads obey RLS.
      const quotaCheck = await this.quota.checkStorage(
        auth.user_id,
        totalSize,
        tx,
      );
      if (!quotaCheck.allowed) {
        return {
          ok: false as const,
          code: "quota_exceeded" as const,
          message: "Storage limit exceeded.",
        };
      }

      const currentNode = await this.repo.getNode(
        auth.user_id,
        session.nodeId,
        tx,
      );
      const oldSize = currentNode?.size ?? 0;

      return {
        ok: true as const,
        session,
        chunks,
        totalSize,
        currentNode,
        oldSize,
      };
    });

    if (!preflight.ok) return preflight;
    const { session, chunks, totalSize, currentNode, oldSize } = preflight;

    // Compute file-level hash from chunk checksums
    const concatenatedHashes = chunks.map((c) => c.checksum).join("");
    const fileHash = await sha256Hex(
      new TextEncoder().encode(concatenatedHashes).buffer as ArrayBuffer,
    );

    const storagePrefix = sessionStoragePrefix(
      auth.user_id,
      session.nodeId,
      session.id,
    );

    // Complete in a single tx — no 'completing' intermediate state.
    // UPDATE WHERE status='active' acts as CAS (only one complete/cancel wins).
    // Both setStatus CAS failure and commitRevision conflict throw
    // TxRollbackError → triggers ROLLBACK so no partial writes commit.
    const committed = await this.db
      .withUserWriteTx(this.userId, async (tx) => {
        const acquired = await this.sessions.setStatus(
          sessionId,
          "completed",
          "active",
          tx,
        );
        if (!acquired) {
          throw new TxRollbackError("conflict" as const);
        }

        return this.fileService.commitRevision(
          {
            userId: auth.user_id,
            nodeId: session.nodeId,
            revisionId: session.revisionId,
            revision: {
              storagePrefix,
              contentType:
                currentNode?.contentType ?? "application/octet-stream",
              chunkCount: chunks.length,
              size: totalSize,
              hash: fileHash,
            },
            contentVersionCas: session.baseContentVersion,
            oldSize,
          },
          tx,
        );
      })
      .catch(TxRollbackError.into);

    if (!committed.ok) {
      // tx rolled back — status is still 'active', mark as failed.
      // Must run inside withUserWriteTx: RLS rejects bare-connection
      // UPDATEs without `app.user_id` GUC, which would silently leave the
      // session 'active' until cron expiry.
      const marked = await this.db.withUserWriteTx(this.userId, (tx) =>
        this.sessions.setStatus(sessionId, "failed", "active", tx),
      );
      if (!marked) {
        // CAS miss: session no longer 'active' (raced with cancelSession or
        // expiry cleanup). Don't overwrite — log so we can spot a real RLS
        // regression vs. an expected race.
        logWarn("upload_service", "failed_status_mark_cas_miss", {
          userId: this.userId,
          sessionId,
        });
      }
      return {
        ok: false,
        code: "conflict",
        message:
          "Conflict: file was modified concurrently. Start a new session.",
      };
    }

    return {
      ok: true,
      nodeId: session.nodeId,
      size: totalSize,
      chunkCount: chunks.length,
      contentVersion: committed.contentVersion,
    };
  }

  // ---- cancelSession --------------------------------------------------------

  async cancelSession(
    auth: AuthContext,
    sessionId: string,
  ): Promise<
    | { ok: true }
    | { ok: false; code: "not_found" | "conflict"; message: string }
  > {
    assertServiceUserMatches(auth, this.userId);
    const result = await this.db.withUserWriteTx(this.userId, async (tx) => {
      const session = await this.sessions.get(auth.user_id, sessionId, tx);
      if (!session) {
        return SESSION_NOT_FOUND_ERROR;
      }
      if (session.status === "completed") {
        return {
          ok: false as const,
          code: "conflict" as const,
          message: "Cannot cancel a completed session",
        };
      }

      // CAS: only cancel if still active
      const updated = await this.sessions.setStatus(
        sessionId,
        "failed",
        "active",
        tx,
      );
      if (!updated) {
        // Already completed or failed by another request
        return {
          ok: false as const,
          code: "conflict" as const,
          message: `Session is ${session.status}`,
        };
      }

      const chunks = await this.sessions.getChunks(sessionId, tx);
      const storagePrefix =
        chunks.length > 0
          ? sessionStoragePrefix(auth.user_id, session.nodeId, session.id)
          : null;

      await this.sessions.delete(sessionId, tx);

      return { ok: true as const, storagePrefix };
    });

    if (!result.ok) return result;

    // Enqueue a tombstone for the session prefix instead of
    // deleting storage here. cancel = no commit happened, so no file_revisions
    // row was ever created and the prefix is exclusively this session's
    // partial chunks — safe to reap from GC. Done outside the tx since
    // enqueueStorageTombstone runs its own writes.
    if (result.storagePrefix) {
      try {
        await enqueueStorageTombstone(this.db, result.storagePrefix);
      } catch (e) {
        logError(
          "upload_service",
          "tombstone_enqueue_failed",
          { storagePrefix: result.storagePrefix },
          e,
        );
      }
    }

    return { ok: true };
  }
}

class UploadSessionNotActiveError extends Error {
  constructor(public readonly status: string) {
    super(`Session is ${status}`);
  }
}
