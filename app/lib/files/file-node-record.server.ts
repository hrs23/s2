// Shared types and SQL fragments for file-node repositories.
// Extracted from file-node-repository.server.ts to avoid circular imports
// between FileNodeRepository, TrashRepository, and VersionRepository.

import { coercePgInstant } from "~/lib/db/coerce.server";

export interface FileNode {
  id: string;
  userId: string;
  parentId: string;
  name: string;
  contentType: string;
  isDirectory: boolean;
  contentVersion: number;
  currentRevisionId: string | null;
  deletedAt: string | null;
  size: number | null; // cached from file_revisions
  updatedAt: string | null; // cached from file_revisions
  createdAt: string;
  // Revision fields (populated when joined with file_revisions)
  storagePrefix: string | null;
  chunkCount: number | null;
  revisionContentType: string | null; // content_type from file_revisions
  revisionId: string | null; // file_revisions.id
  hash: string | null;
}

export interface FileNodeRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  content_type: string;
  is_directory: boolean;
  content_version: number;
  current_revision_id: string | null;
  deleted_at: Date | string | null;
  cached_size: number | null;
  cached_updated_at: Date | string | null;
  created_at: Date | string;
  // Revision fields (from LEFT JOIN)
  storage_prefix: string | null;
  chunk_count: number | null;
  rev_content_type: string | null;
  rev_id: string | null;
  hash: string | null;
}

export const NODE_SELECT = `
    fn.id, fn.user_id, fn.parent_id, fn.name,
    fn.content_type, fn.is_directory, fn.content_version,
    fn.current_revision_id, fn.deleted_at,
    fn.cached_size, fn.cached_updated_at, fn.created_at,
    fr.storage_prefix,
    fr.chunk_count, fr.content_type AS rev_content_type,
    fr.id AS rev_id,
    fr.hash
  `;

export const NODE_JOIN = `
    FROM file_nodes fn
    LEFT JOIN file_revisions fr ON fn.current_revision_id = fr.id
  `;

export function rowToNode(row: FileNodeRow): FileNode {
  return {
    id: row.id,
    userId: row.user_id,
    // Map the DB NULL root to the TS API "" sentinel.
    parentId: row.parent_id ?? "",
    name: row.name,
    contentType: row.rev_content_type ?? row.content_type,
    isDirectory: !!row.is_directory,
    contentVersion: row.content_version ?? 0,
    currentRevisionId: row.current_revision_id ?? null,
    deletedAt: coercePgInstant(row.deleted_at),
    size: row.cached_size ?? null,
    updatedAt: coercePgInstant(row.cached_updated_at),
    createdAt: coercePgInstant(row.created_at) ?? "",
    storagePrefix: row.storage_prefix ?? null,
    chunkCount: row.chunk_count ?? null,
    revisionContentType: row.rev_content_type ?? null,
    revisionId: row.rev_id ?? null,
    hash: row.hash ?? null,
  };
}
