// Upload session repository for large file (>100MB) uploads.

import type { WithinUserTx, WithinUserWriteTx } from "~/lib/db/client.server";
import { coercePgInstant } from "~/lib/db/coerce.server";
import { CHUNK_SIZE } from "~/lib/storage/chunked.server";
import { generateUlidForApi } from "~/lib/utils/ulid.server";

export type SessionStatus = "active" | "completed" | "failed";

export { CHUNK_SIZE };

/** Compute expected chunk count from totalSize and chunkSize. */
export function expectedChunkCount(
  totalSize: number,
  chunkSize: number = CHUNK_SIZE,
): number {
  return Math.ceil(totalSize / chunkSize);
}

export interface UploadSession {
  id: string;
  userId: string;
  nodeId: string;
  baseContentVersion: number;
  revisionId: string;
  chunkSize: number;
  totalSize: number;
  status: SessionStatus;
  expiresAt: string;
  createdAt: string;
}

export interface SessionChunk {
  sessionId: string;
  chunkIndex: number;
  size: number;
  checksum: string;
  createdAt: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  node_id: string;
  base_content_version: number;
  revision_id: string;
  chunk_size: number;
  total_size: number;
  status: SessionStatus;
  expires_at: Date | string;
  created_at: Date | string;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class UploadSessionRepository {
  async create(
    userId: string,
    nodeId: string,
    baseContentVersion: number,
    revisionId: string,
    totalSize: number,
    tx: WithinUserWriteTx,
  ): Promise<UploadSession> {
    const id = generateUlidForApi();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    const nowIso = now.toISOString();

    await tx.execute(
      `INSERT INTO upload_sessions
         (id, user_id, node_id, base_content_version,
          revision_id, chunk_size, total_size, status, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)`,
      [
        id,
        userId,
        nodeId,
        baseContentVersion,
        revisionId,
        CHUNK_SIZE,
        totalSize,
        expiresAt,
        nowIso,
      ],
    );

    return {
      id,
      userId,
      nodeId,
      baseContentVersion,
      revisionId,
      chunkSize: CHUNK_SIZE,
      totalSize,
      status: "active",
      expiresAt,
      createdAt: nowIso,
    };
  }

  async get(
    userId: string,
    sessionId: string,
    tx: WithinUserTx,
  ): Promise<UploadSession | null> {
    const row = await tx.queryOne<SessionRow>(
      "SELECT * FROM upload_sessions WHERE id = $1 AND user_id = $2",
      [sessionId, userId],
    );
    if (!row) return null;
    return rowToSession(row);
  }

  async setStatus(
    sessionId: string,
    status: SessionStatus,
    expectedStatus: SessionStatus | undefined,
    tx: WithinUserWriteTx,
  ): Promise<boolean> {
    const sql = expectedStatus
      ? "UPDATE upload_sessions SET status = $1 WHERE id = $2 AND status = $3"
      : "UPDATE upload_sessions SET status = $1 WHERE id = $2";
    const params = expectedStatus
      ? [status, sessionId, expectedStatus]
      : [status, sessionId];
    const result = await tx.execute(sql, params);
    return result.rowCount > 0;
  }

  async recordChunk(
    sessionId: string,
    chunkIndex: number,
    size: number,
    checksum: string,
    tx: WithinUserWriteTx,
  ): Promise<void> {
    await tx.execute(
      `INSERT INTO upload_session_chunks (session_id, chunk_index, size, checksum, created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (session_id, chunk_index) DO UPDATE SET size=$3, checksum=$4`,
      [sessionId, chunkIndex, size, checksum, new Date().toISOString()],
    );
  }

  /** Get the cumulative uploaded size and the size of a specific chunk (for re-upload delta). */
  async getUploadedSize(
    sessionId: string,
    chunkIndex: number | undefined,
    tx: WithinUserTx,
  ): Promise<{ totalUploaded: number; existingChunkSize: number }> {
    const totalRow = await tx.queryOne<{ total: string }>(
      "SELECT COALESCE(SUM(size), 0) AS total FROM upload_session_chunks WHERE session_id = $1",
      [sessionId],
    );
    const totalUploaded = Number(totalRow?.total ?? 0);

    let existingChunkSize = 0;
    if (chunkIndex !== undefined) {
      const chunkRow = await tx.queryOne<{ size: number }>(
        "SELECT size FROM upload_session_chunks WHERE session_id = $1 AND chunk_index = $2",
        [sessionId, chunkIndex],
      );
      existingChunkSize = chunkRow?.size ?? 0;
    }

    return { totalUploaded, existingChunkSize };
  }

  async getChunks(
    sessionId: string,
    tx: WithinUserTx,
  ): Promise<SessionChunk[]> {
    const rows = await tx.query<{
      session_id: string;
      chunk_index: number;
      size: number;
      checksum: string;
      created_at: Date | string;
    }>(
      "SELECT * FROM upload_session_chunks WHERE session_id = $1 ORDER BY chunk_index ASC",
      [sessionId],
    );
    return rows.map((r) => ({
      sessionId: r.session_id,
      chunkIndex: r.chunk_index,
      size: r.size,
      checksum: r.checksum,
      createdAt: coercePgInstant(r.created_at) ?? "",
    }));
  }

  /**
   * Find expired sessions for the given user.
   * Used by session-cleanup cron — per-user iteration under withUserTx;
   * user_id WHERE is defensive double-binding so the query
   * also scopes correctly under the postgres (BYPASSRLS) role.
   */
  async findExpired(
    userId: string,
    tx: WithinUserTx,
  ): Promise<UploadSession[]> {
    const rows = await tx.query<SessionRow>(
      `SELECT * FROM upload_sessions
       WHERE user_id = $1
         AND expires_at < $2
         AND status IN ('active', 'failed')`,
      [userId, new Date().toISOString()],
    );
    return rows.map(rowToSession);
  }

  async delete(sessionId: string, tx: WithinUserWriteTx): Promise<void> {
    // upload_session_chunks cascade-deletes automatically
    await tx.execute("DELETE FROM upload_sessions WHERE id = $1", [sessionId]);
  }
}

function rowToSession(row: SessionRow): UploadSession {
  return {
    id: row.id,
    userId: row.user_id,
    nodeId: row.node_id,
    baseContentVersion: row.base_content_version,
    revisionId: row.revision_id,
    chunkSize: row.chunk_size,
    totalSize: row.total_size,
    status: row.status,
    expiresAt: coercePgInstant(row.expires_at) ?? "",
    createdAt: coercePgInstant(row.created_at) ?? "",
  };
}
