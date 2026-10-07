// TrashRepository: Postgres CRUD for soft-deleted file nodes (trash).
// Extracted from FileNodeRepository.

import type { WithinUserTx, WithinUserWriteTx } from "~/lib/db/client.server";
import {
  type FileNode,
  type FileNodeRow,
  NODE_JOIN,
  NODE_SELECT,
  rowToNode,
} from "./file-node-record.server";

export class TrashRepository {
  /**
   * Walk the parent chain to reconstruct the absolute path of a node, including
   * soft-deleted ancestors. Used to capture the path before physical deletion.
   *
   * Mirrors FileNodeRepository.reconstructPath but is duplicated here to avoid
   * a cross-repository dependency. Returns "/" for nodes that no longer exist.
   */
  private async reconstructNodePath(
    userId: string,
    nodeId: string,
    tx: WithinUserTx,
  ): Promise<string> {
    const rows = await tx.query<{ name: string }>(
      `WITH RECURSIVE chain AS (
        SELECT id, parent_id, name, 0 AS depth
        FROM file_nodes WHERE user_id = $1 AND id = $2
        UNION ALL
        SELECT fn.id, fn.parent_id, fn.name, c.depth + 1
        FROM file_nodes fn JOIN chain c ON fn.id = c.parent_id
        WHERE fn.user_id = $1 AND c.parent_id IS NOT NULL
      )
      SELECT name FROM chain ORDER BY depth DESC`,
      [userId, nodeId],
    );
    if (rows.length === 0) return "/";
    return `/${rows.map((r) => r.name).join("/")}`;
  }

  /**
   * Bulk variant of reconstructNodePath: walk the parent chain for many leaf
   * nodes in a single recursive CTE, keyed by `root_id` so each leaf's chain
   * is built independently. Returns a Map keyed by leaf id; leaves not found
   * in file_nodes are absent (caller falls back to "/").
   *
   * Used to avoid N+1 round-trips during bulk purge.
   */
  private async reconstructNodePathsBulk(
    userId: string,
    nodeIds: string[],
    tx: WithinUserTx,
  ): Promise<Map<string, string>> {
    if (nodeIds.length === 0) return new Map();
    const rows = await tx.query<{
      root_id: string;
      name: string;
      depth: number;
    }>(
      `WITH RECURSIVE chain AS (
        SELECT id AS root_id, id, parent_id, name, 0 AS depth
        FROM file_nodes
        WHERE user_id = $1 AND id = ANY($2)
        UNION ALL
        SELECT c.root_id, fn.id, fn.parent_id, fn.name, c.depth + 1
        FROM file_nodes fn JOIN chain c ON fn.id = c.parent_id
        WHERE fn.user_id = $1 AND c.parent_id IS NOT NULL
      )
      SELECT root_id, name, depth FROM chain ORDER BY root_id, depth DESC`,
      [userId, nodeIds],
    );
    // Rows arrive root-first (ORDER BY depth DESC), so concatenating "/name"
    // per row yields "/ancestor/.../leaf" without an intermediate array.
    const out = new Map<string, string>();
    for (const r of rows) {
      out.set(r.root_id, `${out.get(r.root_id) ?? ""}/${r.name}`);
    }
    return out;
  }

  /**
   * Soft-delete a node. Sets deleted_at on the node and all descendants.
   * bytes_used is NOT changed (trash counts toward quota).
   */
  async softDeleteNode(
    userId: string,
    nodeId: string,
    tx: WithinUserWriteTx,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    // Mark the node and all descendants as deleted using recursive CTE
    const result = await tx.execute(
      `WITH RECURSIVE subtree AS (
        SELECT id FROM file_nodes WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL
        UNION ALL
        SELECT fn.id FROM file_nodes fn
        JOIN subtree s ON fn.parent_id = s.id
        WHERE fn.user_id = $1 AND fn.deleted_at IS NULL
      )
      UPDATE file_nodes SET deleted_at = $3
      WHERE id IN (SELECT id FROM subtree)`,
      [userId, nodeId, now],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Restore a node from trash. Sets deleted_at = NULL on the node and all descendants.
   * Returns "ok", "not_found", or "conflict".
   */
  async restoreNode(
    userId: string,
    nodeId: string,
    tx: WithinUserWriteTx,
  ): Promise<"ok" | "not_found" | "conflict" | "parent_in_trash"> {
    // Get the node to check for name conflicts
    const node = await tx.queryOne<{
      parent_id: string | null;
      name: string;
    }>(
      "SELECT parent_id, name FROM file_nodes WHERE user_id = $1 AND id = $2 AND deleted_at IS NOT NULL",
      [userId, nodeId],
    );
    if (!node) return "not_found";

    // Check if the parent is live (skip for root nodes where parent_id IS NULL)
    if (node.parent_id !== null) {
      const parentAlive = await tx.queryOne<{ id: string }>(
        "SELECT id FROM file_nodes WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL",
        [userId, node.parent_id],
      );
      if (!parentAlive) return "parent_in_trash";
    }

    // Check if a live node with the same name already exists
    // node.parent_id may be null (root); IS NOT DISTINCT FROM treats null = null.
    const conflict = await tx.queryOne<{ id: string }>(
      "SELECT id FROM file_nodes WHERE user_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND name = $3 AND deleted_at IS NULL",
      [userId, node.parent_id, node.name],
    );
    if (conflict) return "conflict";

    // Restore the node and all descendants
    await tx.execute(
      `WITH RECURSIVE subtree AS (
        SELECT id FROM file_nodes WHERE user_id = $1 AND id = $2
        UNION ALL
        SELECT fn.id FROM file_nodes fn
        JOIN subtree s ON fn.parent_id = s.id
        WHERE fn.user_id = $1 AND fn.deleted_at IS NOT NULL
      )
      UPDATE file_nodes SET deleted_at = NULL
      WHERE user_id = $1 AND id IN (SELECT id FROM subtree)`,
      [userId, nodeId],
    );
    return "ok";
  }

  /**
   * List top-level trash items for a user (nodes whose parent is NOT in trash).
   */
  async listTrash(userId: string, tx: WithinUserTx): Promise<FileNode[]> {
    const rows = await tx.query<FileNodeRow>(
      `SELECT ${NODE_SELECT}
       ${NODE_JOIN}
       WHERE fn.user_id = $1 AND fn.deleted_at IS NOT NULL
         AND (fn.parent_id IS NULL OR fn.parent_id NOT IN (
           SELECT id FROM file_nodes WHERE user_id = $1 AND deleted_at IS NOT NULL
         ))
       ORDER BY fn.deleted_at DESC`,
      [userId],
    );
    return rows.map((row) => rowToNode(row));
  }

  /**
   * Get a node that is in trash (deleted_at IS NOT NULL).
   * Complementary to getNode which only returns live nodes.
   */
  async getTrashNode(
    userId: string,
    nodeId: string,
    tx: WithinUserTx,
  ): Promise<FileNode | null> {
    const row = await tx.queryOne<FileNodeRow>(
      `SELECT ${NODE_SELECT}
       ${NODE_JOIN}
       WHERE fn.user_id = $1 AND fn.id = $2 AND fn.deleted_at IS NOT NULL`,
      [userId, nodeId],
    );
    if (!row) return null;
    return rowToNode(row);
  }

  /**
   * Physically delete expired trash nodes and return their info for storage
   * cleanup. Path / is_directory / current_revision_id are captured BEFORE the
   * DELETE so callers have full context after CASCADE.
   *
   * Uses SELECT ... FOR UPDATE to prevent race with restoreNode.
   */
  async purgeExpiredTrash(
    userId: string,
    maxAge: number = 30 * 24 * 60 * 60 * 1000, // 30 days in ms
    tx: WithinUserWriteTx,
  ): Promise<{
    nodes: {
      id: string;
      pathBefore: string;
      isDirectory: boolean;
      currentRevisionId: string | null;
    }[];
    revisions: { storagePrefix: string; chunkCount: number }[];
    totalSize: number;
  }> {
    const cutoff = new Date(Date.now() - maxAge).toISOString();

    // Select expired nodes with lock; capture is_directory + current_revision_id
    // up-front so callers have full context after CASCADE.
    // user_id is enforced both via WHERE and via RLS app.user_id under app role
    // — defensive double-binding so non-RLS contexts (postgres role,
    // pg superuser test) still scope correctly.
    const rows = await tx.query<{
      id: string;
      is_directory: boolean;
      current_revision_id: string | null;
    }>(
      `SELECT id, is_directory, current_revision_id
       FROM file_nodes
       WHERE user_id = $1 AND deleted_at IS NOT NULL AND deleted_at < $2
       FOR UPDATE SKIP LOCKED`,
      [userId, cutoff],
    );

    if (rows.length === 0) {
      return { nodes: [], revisions: [], totalSize: 0 };
    }

    const ids = rows.map((n) => n.id);

    // Reconstruct each node's path BEFORE deletion (path is lost after CASCADE).
    // Bulk CTE: one round-trip for all leaves.
    const pathByNodeId = await this.reconstructNodePathsBulk(userId, ids, tx);

    // Collect all revisions for storage cleanup AND size accounting (before CASCADE)
    // Sum ALL revision sizes, not just cached_size (current only)
    const revisions = await tx.query<{
      storage_prefix: string;
      chunk_count: number;
      size: number;
    }>(
      `SELECT storage_prefix, chunk_count, size FROM file_revisions
        WHERE user_id = $1 AND node_id = ANY($2)`,
      [userId, ids],
    );

    let totalSize = 0;
    for (const rev of revisions) {
      totalSize += Number(rev.size);
    }

    // Physical delete (CASCADE cleans file_revisions etc.)
    await tx.execute(
      `DELETE FROM file_nodes WHERE user_id = $1 AND id = ANY($2)`,
      [userId, ids],
    );

    return {
      nodes: rows.map((n) => ({
        id: n.id,
        pathBefore: pathByNodeId.get(n.id) ?? "/",
        isDirectory: !!n.is_directory,
        currentRevisionId: n.current_revision_id,
      })),
      revisions: revisions.map((r) => ({
        storagePrefix: r.storage_prefix,
        chunkCount: r.chunk_count,
      })),
      totalSize,
    };
  }

  /**
   * Force-purge ALL trash for a specific user (regardless of age).
   * Used by over-quota enforcement (30-day stage).
   * Captures path / is_directory / current_revision_id BEFORE the DELETE so
   * callers have full context.
   */
  async purgeUserTrash(
    userId: string,
    tx: WithinUserWriteTx,
  ): Promise<{
    nodes: {
      id: string;
      pathBefore: string;
      isDirectory: boolean;
      currentRevisionId: string | null;
    }[];
    revisions: { storagePrefix: string; chunkCount: number; size: number }[];
  }> {
    const rows = await tx.query<{
      id: string;
      is_directory: boolean;
      current_revision_id: string | null;
    }>(
      `SELECT id, is_directory, current_revision_id FROM file_nodes
       WHERE user_id = $1 AND deleted_at IS NOT NULL
       FOR UPDATE SKIP LOCKED`,
      [userId],
    );

    if (rows.length === 0) return { nodes: [], revisions: [] };

    const ids = rows.map((n) => n.id);

    // Reconstruct each node's path BEFORE deletion. Bulk CTE: one round-trip
    // for all leaves. Path is lost after the CASCADE DELETE below.
    const pathByNodeId = await this.reconstructNodePathsBulk(userId, ids, tx);

    // Defensive user_id rebinding here matches purgeExpiredTrash:
    // double-bind via WHERE in addition to RLS so non-RLS contexts still scope.
    const revisions = await tx.query<{
      storage_prefix: string;
      chunk_count: number;
      size: number;
    }>(
      `SELECT storage_prefix, chunk_count, size FROM file_revisions
        WHERE user_id = $1 AND node_id = ANY($2)`,
      [userId, ids],
    );

    await tx.execute(
      `DELETE FROM file_nodes WHERE user_id = $1 AND id = ANY($2)`,
      [userId, ids],
    );

    return {
      nodes: rows.map((n) => ({
        id: n.id,
        pathBefore: pathByNodeId.get(n.id) ?? "/",
        isDirectory: !!n.is_directory,
        currentRevisionId: n.current_revision_id,
      })),
      revisions: revisions.map((r) => ({
        storagePrefix: r.storage_prefix,
        chunkCount: r.chunk_count,
        size: Number(r.size),
      })),
    };
  }

  /**
   * Hard-delete a specific node and all its revisions.
   * Used by over-quota enforcement (90-day stage).
   * Captures path / is_directory / current_revision_id BEFORE the DELETE so
   * callers have full context.
   */
  async purgeNode(
    userId: string,
    nodeId: string,
    tx: WithinUserWriteTx,
  ): Promise<{
    pathBefore: string;
    isDirectory: boolean;
    currentRevisionId: string | null;
    revisions: { storagePrefix: string; chunkCount: number; size: number }[];
  } | null> {
    const node = await tx.queryOne<{
      is_directory: boolean;
      current_revision_id: string | null;
    }>(
      `SELECT is_directory, current_revision_id FROM file_nodes
       WHERE id = $1 AND user_id = $2`,
      [nodeId, userId],
    );
    if (!node) return null;

    const pathBefore = await this.reconstructNodePath(userId, nodeId, tx);

    const revisions = await tx.query<{
      storage_prefix: string;
      chunk_count: number;
      size: number;
    }>(
      `SELECT fr.storage_prefix, fr.chunk_count, fr.size
       FROM file_revisions fr
       JOIN file_nodes fn ON fn.id = fr.node_id
       WHERE fr.node_id = $1 AND fn.user_id = $2`,
      [nodeId, userId],
    );

    const result = await tx.execute(
      `DELETE FROM file_nodes WHERE id = $1 AND user_id = $2`,
      [nodeId, userId],
    );

    if ((result.rowCount ?? 0) === 0) return null;

    return {
      pathBefore,
      isDirectory: !!node.is_directory,
      currentRevisionId: node.current_revision_id,
      revisions: revisions.map((r) => ({
        storagePrefix: r.storage_prefix,
        chunkCount: r.chunk_count,
        size: Number(r.size),
      })),
    };
  }

  /**
   * Physically delete a trash node and all its descendants (recursive).
   * Returns revision info for storage cleanup and total freed bytes.
   * Uses FOR UPDATE to prevent race with restoreNode.
   */
  async purgeTrashSubtree(
    userId: string,
    nodeId: string,
    tx: WithinUserWriteTx,
  ): Promise<{
    nodeIds: string[];
    isDirectory: boolean;
    revisions: { storagePrefix: string; chunkCount: number; size: number }[];
    totalSize: number;
  } | null> {
    // Verify the root node is in trash and lock it
    const root = await tx.queryOne<{ id: string; is_directory: boolean }>(
      `SELECT id, is_directory FROM file_nodes
       WHERE user_id = $1 AND id = $2 AND deleted_at IS NOT NULL
       FOR UPDATE`,
      [userId, nodeId],
    );
    if (!root) return null;

    // Collect all descendant node IDs (including the root) with lock
    const nodeRows = await tx.query<{ id: string }>(
      `WITH RECURSIVE subtree AS (
        SELECT id FROM file_nodes WHERE user_id = $1 AND id = $2
        UNION ALL
        SELECT fn.id FROM file_nodes fn
        JOIN subtree s ON fn.parent_id = s.id
        WHERE fn.user_id = $1
      )
      SELECT id FROM subtree`,
      [userId, nodeId],
    );
    const nodeIds = nodeRows.map((r) => r.id);

    // Collect all revision info before CASCADE delete
    const revRows = await tx.query<{
      storage_prefix: string;
      chunk_count: number;
      size: number;
    }>(
      `SELECT storage_prefix, chunk_count, size FROM file_revisions WHERE node_id = ANY($1)`,
      [nodeIds],
    );

    let totalSize = 0;
    const revisions = revRows.map((r) => {
      const size = Number(r.size);
      totalSize += size;
      return {
        storagePrefix: r.storage_prefix,
        chunkCount: r.chunk_count,
        size,
      };
    });

    // Physical delete (CASCADE cleans file_revisions)
    await tx.execute(`DELETE FROM file_nodes WHERE id = ANY($1)`, [nodeIds]);

    return {
      nodeIds,
      isDirectory: !!root.is_directory,
      revisions,
      totalSize,
    };
  }
}
