// FileNodeRepository: Postgres CRUD for the file tree.
//
// Trash operations → TrashRepository (trash-repository.server.ts)
// Version operations → VersionRepository (version-repository.server.ts)

import type { WithinUserTx, WithinUserWriteTx } from "~/lib/db/client.server";
import { generateUlidForApi } from "~/lib/utils/ulid.server";
import {
  type FileNode,
  type FileNodeRow,
  NODE_JOIN,
  NODE_SELECT,
  rowToNode,
} from "./file-node-record.server";

export class FileNodeRepository {
  /**
   * Resolve a path to a node_id by walking the tree segment by segment.
   * Returns null if any segment is not found.
   */
  async resolvePath(
    userId: string,
    segments: string[],
    tx: WithinUserTx,
  ): Promise<string | null> {
    if (segments.length === 0) return "";
    const normalized = segments.map((s) => s.normalize("NFC"));
    let parentId = ""; // root
    for (const name of normalized) {
      const row = await tx.queryOne<{ id: string }>(
        "SELECT id FROM file_nodes WHERE user_id = $1 AND parent_id IS NOT DISTINCT FROM NULLIF($2, '') AND name = $3 AND deleted_at IS NULL",
        [userId, parentId, name],
      );
      if (!row) return null;
      parentId = row.id;
    }
    return parentId;
  }

  /** Get a single node by id. */
  async getNode(
    userId: string,
    nodeId: string,
    tx: WithinUserTx,
  ): Promise<FileNode | null> {
    const row = await tx.queryOne<FileNodeRow>(
      `SELECT ${NODE_SELECT}
       ${NODE_JOIN}
       WHERE fn.user_id = $1 AND fn.id = $2 AND fn.deleted_at IS NULL`,
      [userId, nodeId],
    );
    if (!row) return null;
    return rowToNode(row);
  }

  /**
   * List children of a directory.
   */
  async getChildren(
    userId: string,
    parentId: string,
    tx: WithinUserTx,
  ): Promise<FileNode[]> {
    const rows = await tx.query<FileNodeRow>(
      `SELECT ${NODE_SELECT}
       ${NODE_JOIN}
       WHERE fn.user_id = $1 AND fn.parent_id IS NOT DISTINCT FROM NULLIF($2, '') AND fn.deleted_at IS NULL
       ORDER BY fn.is_directory DESC, fn.created_at ASC`,
      [userId, parentId],
    );
    return rows.map((row) => rowToNode(row));
  }

  /** Create a new file or directory node. */
  async createNode(
    opts: {
      userId: string;
      parentId: string;
      name: string;
      isDirectory: boolean;
      contentType?: string;
      size?: number | null;
    },
    tx: WithinUserWriteTx,
  ): Promise<FileNode> {
    const { userId, parentId, name, isDirectory, contentType, size } = opts;
    const resolvedContentType = contentType ?? "application/octet-stream";
    const resolvedSize = size ?? null;
    const id = generateUlidForApi();
    const normalizedName = name.normalize("NFC");
    const now = new Date().toISOString();

    // NULLIF($3, '') converts the TS API's "" (root) to NULL in the DB.
    // The FK file_nodes_parent_user_fkey treats NULL as "no parent (root)".
    await tx.execute(
      `INSERT INTO file_nodes (id, user_id, parent_id, name, content_type, is_directory, content_version, cached_size, created_at)
       VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, 0, $7, $8)`,
      [
        id,
        userId,
        parentId,
        normalizedName,
        isDirectory ? "inode/directory" : resolvedContentType,
        isDirectory,
        resolvedSize,
        now,
      ],
    );

    return {
      id,
      userId,
      parentId,
      name: normalizedName,
      contentType: isDirectory ? "inode/directory" : resolvedContentType,
      isDirectory,
      contentVersion: 0,
      currentRevisionId: null,
      deletedAt: null,
      size: resolvedSize,
      updatedAt: null,
      createdAt: now,
      storagePrefix: null,
      chunkCount: null,
      revisionContentType: null,
      revisionId: null,
      hash: null,
    };
  }

  /**
   * Create a new revision and update file_nodes to point to it.
   * Uses CAS on content_version for optimistic locking.
   * Returns the revision id, or null if CAS failed.
   */
  async createRevision(
    userId: string,
    nodeId: string,
    revisionId: string,
    revision: {
      storagePrefix: string;
      contentType: string;
      chunkCount: number;
      size: number;
      hash: string;
    },
    contentVersionCas: number,
    tx: WithinUserWriteTx,
  ): Promise<string | null> {
    const now = new Date().toISOString();

    // Insert revision (append-only)
    // user_id is denormalized. The composite FK (node_id, user_id) → file_nodes
    // rejects the INSERT on mismatch, so cross-user attacks are blocked at the schema level.
    await tx.execute(
      `INSERT INTO file_revisions (id, node_id, user_id, storage_prefix, content_type, chunk_count, size, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        revisionId,
        nodeId,
        userId,
        revision.storagePrefix,
        revision.contentType,
        revision.chunkCount,
        revision.size,
        revision.hash,
      ],
    );

    // Update file_nodes to point to new revision (CAS)
    const result = await tx.execute(
      `UPDATE file_nodes
       SET current_revision_id = $1,
           content_version = content_version + 1,
           content_type = $2,
           cached_size = $3,
           cached_updated_at = $4
       WHERE user_id = $5 AND id = $6 AND content_version = $7`,
      [
        revisionId,
        revision.contentType,
        revision.size,
        now,
        userId,
        nodeId,
        contentVersionCas,
      ],
    );

    if ((result.rowCount ?? 0) === 0) return null; // CAS failed
    return revisionId;
  }

  /**
   * Restore a historical revision by updating current_revision_id.
   *
   * Returns one of three outcomes so callers can produce useful UX
   * (version restore is best-effort — the UI may have displayed
   * a revision that has since been pruned / over-quota-deleted / explicitly
   * deleted via the version-delete admin path):
   *
   *   - "ok"            — revision restored
   *   - "revision_gone" — revision row no longer exists for this node
   *                       (race with prune / delete-version; treat as 410)
   *   - "conflict"      — revision exists but the node was modified
   *                       concurrently (content_version CAS mismatch; 409)
   */
  async restoreRevision(
    userId: string,
    nodeId: string,
    revisionId: string,
    contentVersionCas: number,
    tx: WithinUserWriteTx,
  ): Promise<"ok" | "revision_gone" | "conflict"> {
    // Get revision metadata for cache update
    const rev = await tx.queryOne<{
      size: number;
      content_type: string;
    }>(
      "SELECT size, content_type FROM file_revisions WHERE id = $1 AND node_id = $2",
      [revisionId, nodeId],
    );
    if (!rev) return "revision_gone";

    const now = new Date().toISOString();
    const result = await tx.execute(
      `UPDATE file_nodes
       SET current_revision_id = $1,
           content_version = content_version + 1,
           content_type = $2,
           cached_size = $3,
           cached_updated_at = $4
       WHERE user_id = $5 AND id = $6 AND content_version = $7 AND deleted_at IS NULL`,
      [
        revisionId,
        rev.content_type,
        rev.size,
        now,
        userId,
        nodeId,
        contentVersionCas,
      ],
    );
    return (result.rowCount ?? 0) > 0 ? "ok" : "conflict";
  }

  /**
   * Check if nodeId is an ancestor of potentialDescendant.
   * Used to prevent circular moves (moving a dir into its own subtree).
   */
  async isAncestor(
    userId: string,
    nodeId: string,
    potentialDescendant: string,
    tx: WithinUserTx,
  ): Promise<boolean> {
    if (potentialDescendant === nodeId) return true;
    const row = await tx.queryOne<{ found: boolean }>(
      `WITH RECURSIVE chain AS (
        SELECT parent_id FROM file_nodes
        WHERE user_id = $1 AND id = $3 AND deleted_at IS NULL
        UNION ALL
        SELECT fn.parent_id FROM file_nodes fn
        JOIN chain c ON fn.id = c.parent_id
        WHERE fn.user_id = $1 AND fn.deleted_at IS NULL AND c.parent_id IS NOT NULL
      )
      SELECT EXISTS(SELECT 1 FROM chain WHERE parent_id = $2) AS found`,
      [userId, nodeId, potentialDescendant],
    );
    return row?.found ?? false;
  }

  /**
   * Move/rename a node. Throws if the move would create a cycle.
   */
  async moveNode(
    userId: string,
    nodeId: string,
    newParentId: string,
    newName: string,
    tx: WithinUserWriteTx,
  ): Promise<boolean> {
    // Prevent moving a node into its own subtree
    if (
      newParentId !== "" &&
      (await this.isAncestor(userId, nodeId, newParentId, tx))
    ) {
      throw new Error("Cannot move a directory into its own subtree");
    }
    const normalizedName = newName.normalize("NFC");

    const result = await tx.execute(
      `UPDATE file_nodes
       SET parent_id = NULLIF($1, ''), name = $2
       WHERE user_id = $3 AND id = $4 AND deleted_at IS NULL`,
      [newParentId, normalizedName, userId, nodeId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Ensure all intermediate directories exist for a path.
   * Returns the node_id of the final directory.
   */
  async ensureDirectoryPath(
    userId: string,
    segments: string[],
    tx: WithinUserWriteTx,
  ): Promise<string> {
    let parentId = ""; // root
    for (const segment of segments) {
      const name = segment.normalize("NFC");
      const row = await tx.queryOne<{
        id: string;
        is_directory: boolean;
      }>(
        "SELECT id, is_directory FROM file_nodes WHERE user_id = $1 AND parent_id IS NOT DISTINCT FROM NULLIF($2, '') AND name = $3 AND deleted_at IS NULL",
        [userId, parentId, name],
      );
      if (row) {
        if (!row.is_directory) {
          throw new Error("Path segment is a file, not a directory");
        }
        parentId = row.id;
      } else {
        const node = await this.createNode(
          {
            userId,
            parentId,
            name: segment,
            isDirectory: true,
          },
          tx,
        );
        parentId = node.id;
      }
    }
    return parentId;
  }

  /**
   * Resolve a path, creating intermediate directories as needed.
   * Returns { nodeId, existed } for the final segment (file or directory).
   */
  async resolveOrCreate(
    opts: {
      userId: string;
      segments: string[];
      isDirectory: boolean;
      contentType?: string;
      size?: number | null;
    },
    tx: WithinUserWriteTx,
  ): Promise<{ nodeId: string; existed: boolean }> {
    const { userId, segments, isDirectory, contentType, size } = opts;
    if (segments.length === 0) {
      return { nodeId: "", existed: true }; // root
    }
    const parentSegments = segments.slice(0, -1);
    const fileName = segments[segments.length - 1];

    const parentId =
      parentSegments.length > 0
        ? await this.ensureDirectoryPath(userId, parentSegments, tx)
        : "";

    const normalizedName = fileName.normalize("NFC");
    const existing = await tx.queryOne<{ id: string }>(
      "SELECT id FROM file_nodes WHERE user_id = $1 AND parent_id IS NOT DISTINCT FROM NULLIF($2, '') AND name = $3 AND deleted_at IS NULL",
      [userId, parentId, normalizedName],
    );

    if (existing) {
      return { nodeId: existing.id, existed: true };
    }

    const node = await this.createNode(
      {
        userId,
        parentId,
        name: fileName,
        isDirectory,
        contentType,
        size,
      },
      tx,
    );
    return { nodeId: node.id, existed: false };
  }

  /**
   * Reconstruct the full path for a node by walking up the tree.
   * Includes soft-deleted nodes so deleted files can still be resolved
   * to their former path when needed.
   */
  async reconstructPath(
    userId: string,
    nodeId: string,
    tx: WithinUserTx,
  ): Promise<string> {
    const rows = await tx.query<{
      name: string;
    }>(
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
}
