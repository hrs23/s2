// VersionRepository: Postgres CRUD for file revisions (version history).
// Extracted from FileNodeRepository.

import type { WithinUserTx, WithinUserWriteTx } from "~/lib/db/client.server";
import { coercePgInstant } from "~/lib/db/coerce.server";

export interface RevisionWithNode {
  revisionId: string;
  nodeId: string;
  userId: string;
  currentRevisionId: string | null;
  storagePrefix: string;
  chunkCount: number;
  size: number;
  isDirectory: boolean;
}

export class VersionRepository {
  /**
   * List all revisions for a node (newest first).
   */
  async listRevisions(
    nodeId: string,
    tx: WithinUserTx,
  ): Promise<
    {
      id: string;
      size: number;
      contentType: string;
      hash: string | null;
      createdAt: string;
    }[]
  > {
    const rows = await tx.query<{
      id: string;
      size: number;
      contentType: string;
      hash: string | null;
      createdAt: Date | string;
    }>(
      `SELECT id, size, content_type AS "contentType", hash, created_at AS "createdAt"
       FROM file_revisions WHERE node_id = $1 ORDER BY created_at DESC`,
      [nodeId],
    );
    return rows.map((r) => ({
      ...r,
      createdAt: coercePgInstant(r.createdAt) ?? "",
    }));
  }

  /**
   * Delete excess revisions for a single node beyond `keepCount` (oldest first).
   * Returns storage info for the deleted revisions so the caller can clean up storage.
   */
  async pruneNodeRevisions(
    nodeId: string,
    keepCount: number,
    tx: WithinUserWriteTx,
  ): Promise<{ storagePrefix: string; chunkCount: number; size: number }[]> {
    const rows = await tx.query<{
      storage_prefix: string;
      chunk_count: number;
      size: number;
    }>(
      `DELETE FROM file_revisions
       WHERE node_id = $1
         AND id NOT IN (
           SELECT id FROM file_revisions
           WHERE node_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2
         )
       RETURNING storage_prefix, chunk_count, size`,
      [nodeId, keepCount],
    );
    return rows.map((r) => ({
      storagePrefix: r.storage_prefix,
      chunkCount: r.chunk_count,
      size: Number(r.size),
    }));
  }

  /**
   * Delete a non-current revision in a single SQL statement.
   * The WHERE clause ensures we never delete the current revision (race-safe).
   */
  async deleteNonCurrentRevision(
    revisionId: string,
    tx: WithinUserWriteTx,
  ): Promise<{
    storagePrefix: string;
    chunkCount: number;
    size: number;
  } | null> {
    const row = await tx.queryOne<{
      storage_prefix: string;
      chunk_count: number;
      size: number;
    }>(
      `DELETE FROM file_revisions fr
       USING file_nodes fn
       WHERE fr.id = $1
         AND fr.node_id = fn.id
         AND fn.current_revision_id <> fr.id
       RETURNING fr.storage_prefix, fr.chunk_count, fr.size`,
      [revisionId],
    );
    if (!row) return null;
    return {
      storagePrefix: row.storage_prefix,
      chunkCount: row.chunk_count,
      size: Number(row.size),
    };
  }

  /**
   * Get a revision along with its owning node info.
   * Used by deleteVersion to verify ownership and current-revision status.
   */
  async getRevisionWithNode(
    revisionId: string,
    tx: WithinUserTx,
  ): Promise<RevisionWithNode | null> {
    const row = await tx.queryOne<{
      rev_id: string;
      node_id: string;
      user_id: string;
      current_revision_id: string | null;
      storage_prefix: string;
      chunk_count: number;
      size: number;
      is_directory: boolean;
    }>(
      `SELECT fr.id AS rev_id, fr.node_id, fn.user_id,
              fn.current_revision_id, fr.storage_prefix, fr.chunk_count, fr.size,
              fn.is_directory
       FROM file_revisions fr
       JOIN file_nodes fn ON fn.id = fr.node_id
       WHERE fr.id = $1`,
      [revisionId],
    );
    if (!row) return null;
    return {
      revisionId: row.rev_id,
      nodeId: row.node_id,
      userId: row.user_id,
      currentRevisionId: row.current_revision_id,
      storagePrefix: row.storage_prefix,
      chunkCount: row.chunk_count,
      size: Number(row.size),
      isDirectory: !!row.is_directory,
    };
  }

  /**
   * Delete file_revisions beyond maxPastVersions for the given user's files.
   * Excludes the current revision and trash nodes (handled by trash purge).
   * Returns deleted revisions for storage cleanup.
   *
   * Each row carries `revisionId` and the node's current absolute path. Path is reconstructed pre-DELETE — file_nodes
   * itself is not deleted here, so the path remains queryable, but we still
   * snapshot it inside the same statement set to keep tx semantics simple.
   *
   * user_id is enforced both via WHERE and via RLS app.user_id under app role
   * — defensive double-binding so non-RLS contexts (postgres role,
   * pg superuser test) still scope correctly.
   */
  async pruneExcessRevisions(
    userId: string,
    maxPastVersions: number,
    tx: WithinUserWriteTx,
  ): Promise<
    Array<{
      revisionId: string;
      nodeId: string;
      pathAfter: string;
      storagePrefix: string;
      chunkCount: number;
      size: number;
    }>
  > {
    if (maxPastVersions < 0) return [];

    // Rank non-current past revisions per node (newest first).
    // Keep top maxPastVersions; delete the rest.
    const excess = await tx.query<{
      id: string;
      node_id: string;
      storage_prefix: string;
      chunk_count: number;
      size: number;
    }>(
      `SELECT fr.id, fr.node_id, fr.storage_prefix, fr.chunk_count, fr.size
       FROM (
         SELECT fr2.id, fr2.node_id, fr2.storage_prefix, fr2.chunk_count, fr2.size,
                ROW_NUMBER() OVER (PARTITION BY fr2.node_id ORDER BY fr2.created_at DESC, fr2.id DESC) AS rn
         FROM file_revisions fr2
         WHERE fr2.user_id = $1
       ) fr
       JOIN file_nodes fn ON fr.node_id = fn.id
       WHERE fn.user_id = $1
         AND fr.id != fn.current_revision_id
         AND fn.deleted_at IS NULL
         AND fr.rn > $2 + 1`,
      [userId, maxPastVersions],
    );

    if (excess.length === 0) return [];

    // Reconstruct each node's absolute path BEFORE deleting revisions so the
    // returned paths are consistent with the rest of the tx.
    // Bulk CTE: one round-trip for all unique nodes (mirrors
    // TrashRepository.reconstructNodePathsBulk).
    const uniqueNodeIds = Array.from(new Set(excess.map((r) => r.node_id)));
    const pathByNodeId = await this.reconstructNodePathsBulk(
      userId,
      uniqueNodeIds,
      tx,
    );

    const ids = excess.map((r) => r.id);
    await tx.execute(
      "DELETE FROM file_revisions WHERE user_id = $1 AND id = ANY($2)",
      [userId, ids],
    );

    return excess.map((r) => ({
      revisionId: r.id,
      nodeId: r.node_id,
      pathAfter: pathByNodeId.get(r.node_id) ?? "/",
      storagePrefix: r.storage_prefix,
      chunkCount: r.chunk_count,
      size: Number(r.size),
    }));
  }

  /**
   * Bulk variant of reconstructNodePath: walk the parent chain for many leaf
   * nodes in one recursive CTE, keyed by `root_id`. Mirrors the same helper
   * in TrashRepository — duplicated here to avoid cross-repository coupling
   * (same rationale as the singular `reconstructNodePath`). Used during bulk
   * version pruning to avoid N+1 round-trips.
   */
  private async reconstructNodePathsBulk(
    userId: string,
    nodeIds: string[],
    tx: WithinUserTx,
  ): Promise<Map<string, string>> {
    if (nodeIds.length === 0) return new Map();
    const rows = await tx.query<{ root_id: string; name: string }>(
      `WITH RECURSIVE chain AS (
        SELECT id AS root_id, id, parent_id, name, 0 AS depth
        FROM file_nodes
        WHERE user_id = $1 AND id = ANY($2)
        UNION ALL
        SELECT c.root_id, fn.id, fn.parent_id, fn.name, c.depth + 1
        FROM file_nodes fn JOIN chain c ON fn.id = c.parent_id
        WHERE fn.user_id = $1 AND c.parent_id IS NOT NULL
      )
      SELECT root_id, name FROM chain ORDER BY root_id, depth DESC`,
      [userId, nodeIds],
    );
    const out = new Map<string, string>();
    for (const r of rows) {
      out.set(r.root_id, `${out.get(r.root_id) ?? ""}/${r.name}`);
    }
    return out;
  }
}
