// FileService: protocol-agnostic file operations layer.
// Centralizes permission checks, quota enforcement, and storage.
// Used by both WebDAV handlers and REST API routes.

import { assertServiceUserMatches } from "~/lib/auth/auth-assertions.server";
import type { IAuthorizationService } from "~/lib/auth/authorization-service.server";
import type { IQuotaService } from "~/lib/auth/quota-service.server";
import type { AuthContext } from "~/lib/auth/types";
import { enqueueStorageTombstone } from "~/lib/cron/storage-gc.server";
import type {
  DbClient,
  WithinUserTx,
  WithinUserWriteTx,
} from "~/lib/db/client.server";
import { TxRollbackError } from "~/lib/db/tx-error";
import { logInfo, logWarn } from "~/lib/observability/logger.server";
import type { ChunkedStorage } from "~/lib/storage/chunked.server";
import { generateUlidForApi } from "~/lib/utils/ulid.server";
import type { FileNode } from "./file-node-record.server";
import type { FileNodeRepository } from "./file-node-repository.server";
import { parseClientPath } from "./paths";
import type { TrashRepository } from "./trash-repository.server";
import type { VersionRepository } from "./version-repository.server";

type FileActor = "web" | "token" | "system";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type FileResult<T, E extends string> =
  | (T & { ok: true })
  | { ok: false; code: E };

/**
 * HTTP-style byte range request (RFC 9110 §14.1.2), in its syntactic form.
 * Resolution against actual file size (clamping, 416 detection) is performed
 * by FileService inside the same revision snapshot.
 *
 * - `bounded`: bytes=N-M (inclusive on both ends).
 * - `from`:    bytes=N-  (from N to end of file).
 * - `suffix`:  bytes=-N  (last N bytes; if N>=size, the whole file).
 */
export type ByteRangeSpec =
  | { type: "bounded"; firstByte: number; lastByte: number }
  | { type: "from"; firstByte: number }
  | { type: "suffix"; suffixLength: number };

export interface GetFileOptions {
  range?: ByteRangeSpec;
  /**
   * Conditional range application (protocol-neutral form of HTTP If-Range).
   * If set, the range is applied only when the current contentVersion equals
   * this value; otherwise the full body is returned (servedRange undefined).
   * Evaluated atomically with the revision lookup to avoid HEAD/GET races.
   */
  applyRangeIfContentVersion?: number;
}

export interface GetFileResult {
  body: ReadableStream;
  /** Full file size (denominator of Content-Range). */
  size: number;
  /**
   * Number of bytes in `body`. Equals `size` for full responses and
   * `servedRange.length` for range responses. Use this for Content-Length.
   */
  bodySize: number;
  /**
   * Present iff a range was actually applied. `length = lastByte - firstByte + 1`
   * (inclusive). Use to construct Content-Range.
   */
  servedRange?: { offset: number; length: number };
  contentType: string;
  contentVersion: number;
}

export interface HeadFileResult {
  size: number;
  contentType: string;
  contentVersion: number;
}

export interface StatResult {
  nodeId: string;
  isDirectory: boolean;
  size: number | null;
  contentType: string;
  createdAt: string;
  updatedAt: string | null;
  contentVersion: number;
}

export interface FileListItem {
  id: string;
  name: string;
  isDirectory: boolean;
  size: number | null;
  createdAt: string;
  updatedAt: string | null;
  contentType: string;
  contentVersion: number;
  hash: string | null;
  revisionId: string | null;
}

export interface TrashListItem extends FileListItem {
  deletedAt: string | null;
}

export interface PutFileResult {
  nodeId: string;
  existed: boolean;
  size: number;
  hash: string;
  contentVersion: number;
}

export interface DeleteFileResult {
  /** Marker for successful delete (no response body fields). */
  deleted: true;
}

export interface MoveFileResult {
  nodeId: string;
  contentVersion: number;
}

export interface ReplaceFileResult {
  nodeId: string;
  contentVersion: number;
}

export interface MkdirResult {
  nodeId: string;
}

// ---- copyTree (directory copy) -------------------------------------------

/**
 * Per-entry result of `copyTree`. Files carry size/hash/content_version so
 * clients can verify what was written; directories only carry the id.
 *
 * History-preserving semantics: when a file at `destPath` already exists and
 * `overwrite=true`, the existing node identity is kept and a new revision is
 * appended via `putFile` (not delete+recreate). Existing version history at
 * the destination path is therefore preserved.
 */
export type CopyTreeEntryResult =
  | {
      kind: "file";
      srcPath: string;
      destPath: string;
      nodeId: string;
      size: number;
      hash: string;
      contentVersion: number;
      existed: boolean;
    }
  | {
      kind: "directory";
      srcPath: string;
      destPath: string;
      nodeId: string;
      existed: boolean;
    };

interface CopyTreeOk {
  ok: true;
  entries: CopyTreeEntryResult[];
}

/**
 * Partial-success failure: some entries were copied before the walk hit an
 * error. The contract is explicitly non-atomic — already-copied entries stay
 * in place. Callers can use `entries` to reconcile, or retry with the same
 * overwrite flag (history-preserving by design: a successful retry produces
 * one new revision per overlapping file, never an orphan node).
 */
type CopyTreeError =
  | "invalid_source_path"
  | "invalid_dest_path"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "type_mismatch"
  | "quota_exceeded"
  | "cycle";

interface CopyTreeFail {
  ok: false;
  code: CopyTreeError;
  /** Path at which the operation failed (best-effort). */
  failedAtSrc?: string;
  failedAtDest?: string;
  /** Entries successfully copied before the failure (may be empty). */
  entries: CopyTreeEntryResult[];
}

export type CopyTreeResult = CopyTreeOk | CopyTreeFail;

// ---------------------------------------------------------------------------
// commitRevision primitive — shared between putFile and upload completion
// ---------------------------------------------------------------------------

/** Data describing the revision to commit (storage-layer details). */
export interface CommitRevisionParams {
  userId: string;
  nodeId: string;
  revisionId: string;
  revision: {
    storagePrefix: string;
    contentType: string;
    chunkCount: number;
    size: number;
    hash: string;
  };
  /** Current content_version for CAS check. */
  contentVersionCas: number;
  /** Previous size of the file (0 for new files). */
  oldSize: number;
}

/** commitRevision now throws TxRollbackError("conflict") instead of returning ok:false. */
export interface CommitRevisionResult {
  ok: true;
  contentVersion: number;
  prunedRevisions: { storagePrefix: string; chunkCount: number }[];
}

interface RevisionListItem {
  id: string;
  size: number;
  contentType: string;
  hash: string | null;
  createdAt: string;
  isCurrent: boolean;
}

// ---------------------------------------------------------------------------
// Range resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a syntactic `ByteRangeSpec` against the actual file size to a
 * concrete `{ offset, length }`. Returns null when the request is
 * unsatisfiable (RFC 9110 §14.1.2):
 *   - `bounded` / `from` with firstByte >= size
 *   - `suffix` with suffixLength === 0
 *   - any range against a 0-byte file
 */
function resolveByteRange(
  spec: ByteRangeSpec,
  size: number,
): { offset: number; length: number } | null {
  if (size === 0) return null;
  switch (spec.type) {
    case "bounded": {
      if (spec.firstByte >= size) return null;
      const lastByte = Math.min(spec.lastByte, size - 1);
      return { offset: spec.firstByte, length: lastByte - spec.firstByte + 1 };
    }
    case "from": {
      if (spec.firstByte >= size) return null;
      return { offset: spec.firstByte, length: size - spec.firstByte };
    }
    case "suffix": {
      if (spec.suffixLength === 0) return null;
      const length = Math.min(spec.suffixLength, size);
      return { offset: size - length, length };
    }
  }
}

// ---------------------------------------------------------------------------
// IFileService — external contract
// ---------------------------------------------------------------------------

/**
 * Public contract for file-tree operations exposed to external consumers
 * (transport layer: REST, WebDAV). Module-internal helpers (`commitRevision`)
 * are intentionally omitted — they are called only by `UploadService` via
 * the concrete class.
 */
/**
 * Discriminated return type for `getFile`. `range_not_satisfiable` carries the
 * full size and contentVersion so transport layers can build a correct
 * `Content-Range: bytes *\/SIZE` and `ETag` for 416 without an extra round-trip.
 */
export type GetFileResponse =
  | (GetFileResult & { ok: true })
  | { ok: false; code: "invalid_path" | "forbidden" | "not_found" }
  | {
      ok: false;
      code: "range_not_satisfiable";
      size: number;
      contentVersion: number;
    };

export interface IFileService {
  // ---- Read ---------------------------------------------------------------
  /**
   * Read a file. When `opts.range` is provided, the response may be a
   * `range_not_satisfiable` error or a successful body of `bodySize` bytes
   * (with `servedRange` set). Without `opts.range`, the response is the full
   * file and `bodySize === size`.
   */
  getFile(
    auth: AuthContext,
    rawPath: string,
  ): Promise<
    FileResult<GetFileResult, "invalid_path" | "forbidden" | "not_found">
  >;
  getFile(
    auth: AuthContext,
    rawPath: string,
    opts: GetFileOptions,
  ): Promise<GetFileResponse>;

  headFile(
    auth: AuthContext,
    rawPath: string,
  ): Promise<
    FileResult<HeadFileResult, "invalid_path" | "forbidden" | "not_found">
  >;

  statPath(
    auth: AuthContext,
    rawPath: string,
  ): Promise<
    FileResult<StatResult, "invalid_path" | "forbidden" | "not_found">
  >;

  listDirectory(
    auth: AuthContext,
    rawPath: string,
  ): Promise<
    FileResult<
      { items: FileListItem[] },
      "invalid_path" | "forbidden" | "not_found"
    >
  >;

  // ---- Write --------------------------------------------------------------
  putFile(
    auth: AuthContext,
    rawPath: string,
    body: ArrayBuffer,
    contentType: string,
  ): Promise<
    FileResult<
      PutFileResult,
      "invalid_path" | "forbidden" | "quota_exceeded" | "conflict"
    >
  >;

  mkdir(
    auth: AuthContext,
    rawPath: string,
  ): Promise<
    FileResult<MkdirResult, "invalid_path" | "forbidden" | "conflict">
  >;

  // ---- Mutate -------------------------------------------------------------
  moveFile(
    auth: AuthContext,
    srcRawPath: string,
    destRawPath: string,
  ): Promise<
    FileResult<
      MoveFileResult,
      | "invalid_source_path"
      | "invalid_dest_path"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "cycle"
    >
  >;

  copyFile(
    auth: AuthContext,
    srcRawPath: string,
    destRawPath: string,
    overwrite: boolean,
  ): Promise<
    FileResult<
      PutFileResult,
      | "invalid_source_path"
      | "invalid_dest_path"
      | "forbidden"
      | "not_found"
      | "not_implemented"
      | "quota_exceeded"
      | "conflict"
      | "invalid_path"
    >
  >;

  /**
   * Recursively copy a directory subtree. Non-atomic by design — the walk
   * proceeds entry-by-entry and the result includes the list of entries that
   * were copied before any failure (see `CopyTreeFail.entries`).
   *
   * Source must resolve to a directory. For single-file copies, prefer
   * `copyFile` (this method rejects file sources with `type_mismatch`).
   *
   * History-preserving overwrite: when `overwrite=true` and a destination
   * file already exists at a path inside the subtree, the existing node is
   * kept and a new revision is appended via `putFile`. Version history at
   * the destination is preserved (vs. the delete+recreate semantics WebDAV
   * `COPY Overwrite:T` currently uses at the transport layer). When the
   * destination *root* exists as a directory, entries are merged into it;
   * existing destination files that do not collide with source paths are
   * left untouched.
   */
  copyTree(
    auth: AuthContext,
    srcRawPath: string,
    destRawPath: string,
    overwrite: boolean,
  ): Promise<CopyTreeResult>;

  deleteFile(
    auth: AuthContext,
    rawPath: string,
  ): Promise<
    FileResult<DeleteFileResult, "invalid_path" | "forbidden" | "not_found">
  >;

  replaceFile(
    auth: AuthContext,
    srcRawPath: string,
    destRawPath: string,
  ): Promise<
    FileResult<
      ReplaceFileResult,
      | "invalid_source_path"
      | "invalid_dest_path"
      | "forbidden"
      | "not_found"
      | "type_mismatch"
      | "quota_exceeded"
      | "conflict"
    >
  >;

  // ---- Trash --------------------------------------------------------------
  // Trash management is session-only (gated at /internal/* middleware).
  // Service does not perform additional scope checks; callers are trusted.
  listTrash(auth: AuthContext): Promise<{ items: TrashListItem[] }>;

  restoreTrash(
    auth: AuthContext,
    nodeId: string,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        code: "not_found" | "conflict" | "parent_in_trash";
      }
  >;

  purgeTrashItem(
    auth: AuthContext,
    nodeId: string,
  ): Promise<{ ok: true } | { ok: false; code: "not_found" }>;

  purgeAllTrash(auth: AuthContext): Promise<{ ok: true }>;

  // ---- Versions -----------------------------------------------------------
  listRevisions(
    auth: AuthContext,
    rawPath: string,
  ): Promise<
    FileResult<
      { revisions: RevisionListItem[] },
      "invalid_path" | "forbidden" | "not_found"
    >
  >;

  restoreRevision(
    auth: AuthContext,
    rawPath: string,
    revisionId: string,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        code:
          | "invalid_path"
          | "forbidden"
          | "not_found"
          | "conflict"
          | "revision_gone";
      }
  >;

  deleteVersion(
    auth: AuthContext,
    revisionId: string,
  ): Promise<
    | { ok: true; storagePrefix: string; chunkCount: number }
    | { ok: false; code: "forbidden" | "not_found" | "is_current" }
  >;
}

// ---------------------------------------------------------------------------
// FileService
// ---------------------------------------------------------------------------

export class FileService implements IFileService {
  constructor(
    private db: DbClient,
    private userId: string,
    private storage: ChunkedStorage,
    private repo: FileNodeRepository,
    private trashRepo: TrashRepository,
    private versionRepo: VersionRepository,
    private authz: IAuthorizationService,
    private quota: IQuotaService,
  ) {}

  // ---- commitRevision (shared primitive) ------------------------------------

  /**
   * Atomically commit a revision with in-tx prune: CAS update on file_nodes,
   * prune excess revisions, and quota adjustment — all in one tx.
   *
   * Full-revision accounting. sizeDelta = +new_size - prunedSize.
   * Callers are responsible for writing data to storage *before* calling this.
   * This method must be called inside a `db.transaction()`.
   *
   * @internal Module-internal helper called by UploadService during session
   * completion. Not part of IFileService.
   */
  async commitRevision(
    params: CommitRevisionParams,
    tx: WithinUserWriteTx,
  ): Promise<CommitRevisionResult> {
    const committed = await this.repo.createRevision(
      params.userId,
      params.nodeId,
      params.revisionId,
      params.revision,
      params.contentVersionCas,
      tx,
    );

    if (!committed) {
      throw new TxRollbackError("conflict" as const);
    }

    // In-tx prune: immediately remove excess revisions within this transaction
    const usage = await this.quota.getUsage(params.userId, tx);
    const versionLimit = usage.revision_limit;
    let prunedRevisions: { storagePrefix: string; chunkCount: number }[] = [];
    let prunedSize = 0;
    if (versionLimit > 0) {
      const pruned = await this.versionRepo.pruneNodeRevisions(
        params.nodeId,
        versionLimit,
        tx,
      );
      prunedSize = pruned.reduce((sum, r) => sum + r.size, 0);
      prunedRevisions = pruned;
    }

    // Full-revision delta = +new_size - prunedSize.
    const sizeDelta = params.revision.size - prunedSize;
    await this.quota.updateBytesUsed(params.userId, sizeDelta, tx);

    const newContentVersion = params.contentVersionCas + 1;

    return {
      ok: true,
      contentVersion: newContentVersion,
      prunedRevisions,
    };
  }

  // ---- GET file content ---------------------------------------------------

  async getFile(
    auth: AuthContext,
    rawPath: string,
  ): Promise<
    FileResult<GetFileResult, "invalid_path" | "forbidden" | "not_found">
  >;
  async getFile(
    auth: AuthContext,
    rawPath: string,
    opts: GetFileOptions,
  ): Promise<GetFileResponse>;
  async getFile(
    auth: AuthContext,
    rawPath: string,
    opts?: GetFileOptions,
  ): Promise<GetFileResponse> {
    assertServiceUserMatches(auth, this.userId);
    const parsed = this.parseRawPath(rawPath, auth);
    if (!parsed.ok) return { ok: false, code: "invalid_path" };
    const segments = parsed.segments;

    if (segments.length === 0) return { ok: false, code: "not_found" };

    const resolved = await this.db.withUserTx(this.userId, (tx) =>
      this.resolveAndCheckRead(auth, segments, tx),
    );
    if (!resolved.ok) return resolved;

    const { node } = resolved;
    if (node.isDirectory) return { ok: false, code: "not_found" };

    if (!node.storagePrefix || node.chunkCount === null) {
      return { ok: false, code: "not_found" };
    }

    if (!node.revisionId) return { ok: false, code: "not_found" };

    const size = node.size ?? 0;

    // If a range is requested but the conditional contentVersion does not
    // match the current revision, fall back to a full body. Evaluating this
    // inside the snapshot (same revision lookup as the body fetch) avoids
    // the HEAD/GET race a transport-layer If-Range would otherwise introduce.
    const applyRange =
      opts?.range !== undefined &&
      (opts.applyRangeIfContentVersion === undefined ||
        opts.applyRangeIfContentVersion === node.contentVersion);

    if (applyRange && opts?.range) {
      const resolvedRange = resolveByteRange(opts.range, size);
      if (!resolvedRange) {
        return {
          ok: false,
          code: "range_not_satisfiable",
          size,
          contentVersion: node.contentVersion,
        };
      }
      const result = await this.storage.getRange(
        node.storagePrefix,
        node.chunkCount,
        size,
        node.id,
        resolvedRange,
      );
      if (!result) return { ok: false, code: "not_found" };
      return {
        ok: true,
        body: result.body,
        size,
        bodySize: result.length,
        servedRange: { offset: result.offset, length: result.length },
        contentType: node.contentType,
        contentVersion: node.contentVersion,
      };
    }

    const result = await this.storage.get(
      node.storagePrefix,
      node.chunkCount,
      size,
      node.id,
    );
    if (!result) return { ok: false, code: "not_found" };

    return {
      ok: true,
      body: result.body,
      size: result.size,
      bodySize: result.size,
      contentType: node.contentType,
      contentVersion: node.contentVersion,
    };
  }

  // ---- HEAD file metadata -------------------------------------------------

  async headFile(
    auth: AuthContext,
    rawPath: string,
  ): Promise<
    FileResult<HeadFileResult, "invalid_path" | "forbidden" | "not_found">
  > {
    assertServiceUserMatches(auth, this.userId);
    const parsed = this.parseRawPath(rawPath, auth);
    if (!parsed.ok) return { ok: false, code: "invalid_path" };
    const segments = parsed.segments;

    if (segments.length === 0) return { ok: false, code: "not_found" };

    const resolved = await this.db.withUserTx(this.userId, (tx) =>
      this.resolveAndCheckRead(auth, segments, tx),
    );
    if (!resolved.ok) return resolved;

    const { node } = resolved;
    if (node.isDirectory) return { ok: false, code: "not_found" };

    return {
      ok: true,
      size: node.size ?? 0,
      contentType: node.contentType,
      contentVersion: node.contentVersion,
    };
  }

  // ---- stat (node metadata with permission check) -------------------------

  async statPath(
    auth: AuthContext,
    rawPath: string,
  ): Promise<
    FileResult<StatResult, "invalid_path" | "forbidden" | "not_found">
  > {
    assertServiceUserMatches(auth, this.userId);
    const parsed = this.parseRawPath(rawPath, auth);
    if (!parsed.ok) return { ok: false, code: "invalid_path" };
    const segments = parsed.segments;

    const absPath = `/${segments.join("/")}`;

    if (segments.length === 0) {
      if (!this.authz.isVisibleInScope(auth, "/"))
        return { ok: false, code: "forbidden" };
      return {
        ok: true,
        nodeId: "",
        isDirectory: true,
        size: null,
        contentType: "inode/directory",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        contentVersion: 0,
      };
    }

    return this.db.withUserTx(this.userId, async (tx) => {
      // For scoped tokens, the base_path directory is the virtual root.
      // It may not yet exist in the DB — treat it as a synthetic directory.
      if (auth.type === "token") {
        const baseSegments = auth.base_path.split("/").filter(Boolean);
        const isVirtualRoot =
          segments.length === baseSegments.length &&
          segments.every((s, i) => s === baseSegments[i]);
        if (isVirtualRoot) {
          if (!this.authz.isVisibleInScope(auth, absPath))
            return { ok: false as const, code: "forbidden" as const };
          // Try real lookup first; fall back to synthetic if not found
          const nodeId = await this.repo.resolvePath(
            auth.user_id,
            segments,
            tx,
          );
          if (!nodeId) {
            return {
              ok: true as const,
              nodeId: "",
              isDirectory: true,
              size: null,
              contentType: "inode/directory",
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
              contentVersion: 0,
            };
          }
        }
      }

      // Try direct resolution with strict scope check first
      const resolved = await this.resolveAndCheckRead(auth, segments, tx);
      if (!resolved.ok) {
        // For ancestor directories visible via scope (not directly accessible
        // but containing scoped paths), fall back to a visibility-based lookup.
        if (
          resolved.code === "forbidden" &&
          this.authz.isVisibleInScope(auth, absPath)
        ) {
          const nodeId = await this.repo.resolvePath(
            auth.user_id,
            segments,
            tx,
          );
          if (nodeId) {
            const node = await this.repo.getNode(auth.user_id, nodeId, tx);
            if (node?.isDirectory) {
              return {
                ok: true as const,
                nodeId: node.id,
                isDirectory: true,
                size: null,
                contentType: node.contentType,
                createdAt: node.createdAt,
                updatedAt: node.updatedAt,
                contentVersion: node.contentVersion,
              };
            }
          }
          // Node doesn't exist but path is a visible ancestor — synthetic directory
          return {
            ok: true as const,
            nodeId: "",
            isDirectory: true,
            size: null,
            contentType: "inode/directory",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            contentVersion: 0,
          };
        }
        return resolved;
      }

      const { node } = resolved;
      return {
        ok: true as const,
        nodeId: node.id,
        isDirectory: node.isDirectory,
        size: node.size,
        contentType: node.contentType,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        contentVersion: node.contentVersion,
      };
    });
  }

  // ---- List directory children --------------------------------------------

  async listDirectory(
    auth: AuthContext,
    rawPath: string,
  ): Promise<
    FileResult<
      { items: FileListItem[] },
      "invalid_path" | "forbidden" | "not_found"
    >
  > {
    assertServiceUserMatches(auth, this.userId);
    const parsed = this.parseRawPath(rawPath, auth);
    if (!parsed.ok) return { ok: false, code: "invalid_path" };
    const segments = parsed.segments;

    const filePath = `/${segments.join("/")}`;
    // Use isVisibleInScope instead of checkAbsolutePath so that ancestor
    // directories of scoped paths are listable (scope filtering)
    if (!this.authz.isVisibleInScope(auth, filePath))
      return { ok: false, code: "forbidden" };

    const dbResult = await this.db.withUserTx(this.userId, async (tx) => {
      let parentId = "";
      if (segments.length > 0) {
        const nodeId = await this.repo.resolvePath(auth.user_id, segments, tx);
        if (nodeId === null) {
          return { kind: "missing" as const };
        }
        parentId = nodeId;
      }
      const children = await this.repo.getChildren(auth.user_id, parentId, tx);
      return { kind: "found" as const, children };
    });

    if (dbResult.kind === "missing") {
      // For token auth with non-root base_path, the base_path directory may not exist yet.
      // In that case return empty list so tokens can "list" their root before any files are uploaded.
      if (this.isBasepathRoot(auth, segments)) {
        return { ok: true, items: [] };
      }
      return { ok: false, code: "not_found" };
    }

    const items = dbResult.children.map((c) => ({
      id: c.id,
      name: c.name,
      isDirectory: c.isDirectory,
      size: c.size,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      contentType: c.contentType,
      contentVersion: c.contentVersion,
      hash: c.hash,
      revisionId: c.currentRevisionId,
    }));

    // Filter by token scope visibility (hide out-of-scope items)
    if (auth.type === "token") {
      const filtered = items.filter((item) => {
        const childPath =
          filePath === "/" ? `/${item.name}` : `${filePath}/${item.name}`;
        return this.authz.isVisibleInScope(auth, childPath);
      });
      return { ok: true, items: filtered };
    }

    return { ok: true, items };
  }

  // ---- PUT file -----------------------------------------------------------

  async putFile(
    auth: AuthContext,
    rawPath: string,
    body: ArrayBuffer,
    contentType: string,
    opts?: { ifNotExists?: boolean },
  ): Promise<
    FileResult<
      PutFileResult,
      "invalid_path" | "forbidden" | "quota_exceeded" | "conflict"
    >
  > {
    assertServiceUserMatches(auth, this.userId);
    const parsed = this.parseRawPath(rawPath, auth);
    if (!parsed.ok) return { ok: false, code: "invalid_path" };
    const segments = parsed.segments;
    if (segments.length === 0) return { ok: false, code: "invalid_path" };

    const filePath = `/${segments.join("/")}`;
    if (!this.authz.checkAbsolutePath(auth, filePath, "write"))
      return { ok: false, code: "forbidden" };

    // Track storage write for best-effort cleanup on rollback
    let r2Written: { storagePrefix: string; chunkCount: number } | null = null;

    const result = await this.db
      .withUserWriteTx(this.userId, async (tx) => {
        // Pre-flight quota check (rough — authoritative check is in-tx after
        // prune). Inside the user-scoped tx so user_limits / user_storage
        // reads obey RLS.
        const storageCheck = await this.quota.checkStorage(
          auth.user_id,
          body.byteLength,
          tx,
        );
        if (!storageCheck.allowed) {
          throw new TxRollbackError("quota_exceeded" as const);
        }

        const { nodeId, existed } = await this.repo.resolveOrCreate(
          {
            userId: auth.user_id,
            segments,
            isDirectory: false,
            contentType,
            size: body.byteLength,
          },
          tx,
        );

        if (opts?.ifNotExists && existed) {
          throw new TxRollbackError("conflict" as const);
        }

        const currentNode = existed
          ? await this.repo.getNode(auth.user_id, nodeId, tx)
          : null;
        const currentVersion = currentNode?.contentVersion ?? 0;
        const oldSize = currentNode?.size ?? 0;

        const attemptId = generateUlidForApi();
        const revisionId = generateUlidForApi();
        const { chunkCount, storagePrefix, size, hash } =
          await this.storage.put(nodeId, attemptId, body);
        r2Written = { storagePrefix, chunkCount };

        // commitRevision throws TxRollbackError on conflict → triggers ROLLBACK
        const commitResult = await this.commitRevision(
          {
            userId: auth.user_id,
            nodeId,
            revisionId,
            revision: {
              storagePrefix,
              contentType,
              chunkCount,
              size,
              hash,
            },
            contentVersionCas: currentVersion,
            oldSize,
          },
          tx,
        );

        return {
          ok: true as const,
          nodeId,
          existed,
          size,
          hash,
          contentVersion: commitResult.contentVersion,
          prunedRevisions: commitResult.prunedRevisions,
        };
      })
      .catch((e: unknown) => {
        // Tx rolled back after storage PUT, so no file_revisions row
        // exists for the trigger to fire on. Enqueue a tombstone manually
        // so storage-gc reaps the orphan chunks. Fire-and-forget — a stuck
        // enqueue would already mean the DB is broken in a way the cron
        // can't fix from here.
        if (r2Written) {
          const written = r2Written;
          enqueueStorageTombstone(this.db, written.storagePrefix).catch(
            (enqErr) => {
              logWarn(
                "file_service.put",
                "tombstone_enqueue_failed",
                { storagePrefix: written.storagePrefix },
                enqErr,
              );
            },
          );
        }
        return TxRollbackError.into<"conflict" | "quota_exceeded">(e);
      });

    return result;
  }

  // ---- DELETE file/directory ----------------------------------------------

  async deleteFile(
    auth: AuthContext,
    rawPath: string,
  ): Promise<
    FileResult<DeleteFileResult, "invalid_path" | "forbidden" | "not_found">
  > {
    assertServiceUserMatches(auth, this.userId);
    const parsed = this.parseRawPath(rawPath, auth);
    if (!parsed.ok) return { ok: false, code: "invalid_path" };
    const segments = parsed.segments;
    if (segments.length === 0) return { ok: false, code: "invalid_path" };

    const filePath = `/${segments.join("/")}`;
    if (!this.authz.checkAbsolutePath(auth, filePath, "write"))
      return { ok: false, code: "forbidden" };

    const result = await this.db
      .withUserWriteTx(this.userId, async (tx) => {
        const nodeId = await this.repo.resolvePath(auth.user_id, segments, tx);
        if (!nodeId) throw new TxRollbackError("not_found" as const);

        const node = await this.repo.getNode(auth.user_id, nodeId, tx);
        if (!node) throw new TxRollbackError("not_found" as const);

        const ok = await this.trashRepo.softDeleteNode(
          auth.user_id,
          nodeId,
          tx,
        );
        if (!ok) throw new TxRollbackError("not_found" as const);

        // bytes_used is NOT changed — trash counts toward quota
        return { ok: true as const, deleted: true as const };
      })
      .catch(TxRollbackError.into<"not_found">);

    return result;
  }

  // ---- TRASH ----------------------------------------------------------------

  async listTrash(auth: AuthContext): Promise<{ items: TrashListItem[] }> {
    assertServiceUserMatches(auth, this.userId);
    const nodes = await this.db.withUserTx(this.userId, (tx) =>
      this.trashRepo.listTrash(auth.user_id, tx),
    );
    return {
      items: nodes.map((n) => ({
        id: n.id,
        name: n.name,
        isDirectory: n.isDirectory,
        size: n.size,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        contentType: n.contentType,
        contentVersion: n.contentVersion,
        hash: n.hash,
        revisionId: n.currentRevisionId,
        deletedAt: n.deletedAt,
      })),
    };
  }

  async restoreTrash(
    auth: AuthContext,
    nodeId: string,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        code: "not_found" | "conflict" | "parent_in_trash";
      }
  > {
    assertServiceUserMatches(auth, this.userId);
    const result = await this.db
      .withUserWriteTx(this.userId, async (tx) => {
        const restoreResult = await this.trashRepo.restoreNode(
          auth.user_id,
          nodeId,
          tx,
        );
        if (restoreResult !== "ok") throw new TxRollbackError(restoreResult);

        return { ok: true as const };
      })
      .catch(
        TxRollbackError.into<"not_found" | "conflict" | "parent_in_trash">,
      );

    return result;
  }

  // ---- VERSIONING ----------------------------------------------------------

  async listRevisions(
    auth: AuthContext,
    rawPath: string,
  ): Promise<
    FileResult<
      {
        revisions: {
          id: string;
          size: number;
          contentType: string;
          hash: string | null;
          createdAt: string;
          isCurrent: boolean;
        }[];
      },
      "invalid_path" | "forbidden" | "not_found"
    >
  > {
    assertServiceUserMatches(auth, this.userId);
    const parsed = this.parseRawPath(rawPath, auth);
    if (!parsed.ok) return { ok: false, code: "invalid_path" };
    const segments = parsed.segments;
    if (segments.length === 0) return { ok: false, code: "invalid_path" };

    const filePath = `/${segments.join("/")}`;
    if (!this.authz.checkAbsolutePath(auth, filePath, "read"))
      return { ok: false, code: "forbidden" };

    const dbResult = await this.db.withUserTx(this.userId, async (tx) => {
      const nodeId = await this.repo.resolvePath(auth.user_id, segments, tx);
      if (!nodeId) return null;

      const node = await this.repo.getNode(auth.user_id, nodeId, tx);
      if (!node || node.isDirectory) return null;

      const revisions = await this.versionRepo.listRevisions(nodeId, tx);
      return { node, revisions };
    });
    if (!dbResult) return { ok: false, code: "not_found" };

    return {
      ok: true,
      revisions: dbResult.revisions.map((r) => ({
        ...r,
        isCurrent: r.id === dbResult.node.currentRevisionId,
      })),
    };
  }

  async restoreRevision(
    auth: AuthContext,
    rawPath: string,
    revisionId: string,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        code:
          | "invalid_path"
          | "forbidden"
          | "not_found"
          | "conflict"
          | "revision_gone";
      }
  > {
    assertServiceUserMatches(auth, this.userId);
    const parsed = this.parseRawPath(rawPath, auth);
    if (!parsed.ok) return { ok: false, code: "invalid_path" };
    const segments = parsed.segments;
    if (segments.length === 0) return { ok: false, code: "invalid_path" };

    const filePath = `/${segments.join("/")}`;
    if (!this.authz.checkAbsolutePath(auth, filePath, "write"))
      return { ok: false, code: "forbidden" };

    const result = await this.db
      .withUserWriteTx(this.userId, async (tx) => {
        const nodeId = await this.repo.resolvePath(auth.user_id, segments, tx);
        if (!nodeId) throw new TxRollbackError("not_found" as const);

        const node = await this.repo.getNode(auth.user_id, nodeId, tx);
        if (!node || node.isDirectory)
          throw new TxRollbackError("not_found" as const);

        const outcome = await this.repo.restoreRevision(
          auth.user_id,
          nodeId,
          revisionId,
          node.contentVersion,
          tx,
        );
        if (outcome === "revision_gone")
          throw new TxRollbackError("revision_gone" as const);
        if (outcome === "conflict")
          throw new TxRollbackError("conflict" as const);

        return { ok: true as const };
      })
      .catch(TxRollbackError.into<"not_found" | "conflict" | "revision_gone">);

    return result;
  }

  // ---- VERSION DELETE -------------------------------------------

  async deleteVersion(
    auth: AuthContext,
    revisionId: string,
  ): Promise<
    | { ok: true; storagePrefix: string; chunkCount: number }
    | { ok: false; code: "forbidden" | "not_found" | "is_current" }
  > {
    assertServiceUserMatches(auth, this.userId);
    const txResult = await this.db.withUserWriteTx(this.userId, async (tx) => {
      const info = await this.versionRepo.getRevisionWithNode(revisionId, tx);
      if (!info) return { ok: false as const, code: "not_found" as const };

      // Ownership check
      if (info.userId !== auth.user_id)
        return { ok: false as const, code: "not_found" as const };

      // Token authz: check write access to the file's path
      if (auth.type === "token") {
        const path = await this.repo.reconstructPath(
          auth.user_id,
          info.nodeId,
          tx,
        );
        if (!this.authz.checkAbsolutePath(auth, path, "write"))
          return { ok: false as const, code: "forbidden" as const };
      }

      // Current revision guard (checked before SQL, for proper error code)
      if (info.currentRevisionId === revisionId)
        return { ok: false as const, code: "is_current" as const };

      // Race-safe delete: SQL also enforces current_revision_id <> fr.id
      const deleted = await this.versionRepo.deleteNonCurrentRevision(
        revisionId,
        tx,
      );
      if (!deleted) return { ok: false as const, code: "is_current" as const };

      // Update quota
      await this.quota.updateBytesUsed(auth.user_id, -deleted.size, tx);

      // Lifecycle is observed via the structured logger; `path` is intentionally omitted.
      return {
        ok: true as const,
        storagePrefix: deleted.storagePrefix,
        chunkCount: deleted.chunkCount,
        deletedBytes: deleted.size,
        nodeId: info.nodeId,
      };
    });

    if (!txResult.ok) return txResult;

    // Lifecycle is observed via the structured logger.
    logInfo("file_service.delete_version", "deleted", {
      userId: auth.user_id,
      nodeId: txResult.nodeId,
      revisionId,
      deletedBytes: txResult.deletedBytes,
      actor: this.actor(auth),
    });

    return {
      ok: true,
      storagePrefix: txResult.storagePrefix,
      chunkCount: txResult.chunkCount,
    };
  }

  // ---- TRASH PURGE ----------------------------------------------

  async purgeTrashItem(
    auth: AuthContext,
    nodeId: string,
  ): Promise<{ ok: true } | { ok: false; code: "not_found" }> {
    assertServiceUserMatches(auth, this.userId);
    const txResult = await this.db
      .withUserWriteTx(this.userId, async (tx) => {
        // Verify node is in trash
        const trashNode = await this.trashRepo.getTrashNode(
          auth.user_id,
          nodeId,
          tx,
        );
        if (!trashNode) throw new TxRollbackError("not_found" as const);

        // Purge node + all descendants
        const purged = await this.trashRepo.purgeTrashSubtree(
          auth.user_id,
          nodeId,
          tx,
        );
        if (!purged) throw new TxRollbackError("not_found" as const);

        // Update quota
        if (purged.totalSize > 0) {
          await this.quota.updateBytesUsed(auth.user_id, -purged.totalSize, tx);
        }

        // Lifecycle is observed via the structured logger.
        return {
          ok: true as const,
          revisions: purged.revisions,
          purgedBytes: purged.totalSize,
          isDirectory: purged.isDirectory,
        };
      })
      .catch(TxRollbackError.into<"not_found">);

    if (!txResult.ok) return txResult;

    logInfo("file_service.purge_trash", "purged", {
      userId: auth.user_id,
      nodeId,
      isDirectory: txResult.isDirectory,
      purgedBytes: txResult.purgedBytes,
      actor: this.actor(auth),
    });

    return { ok: true };
  }

  async purgeAllTrash(auth: AuthContext): Promise<{ ok: true }> {
    assertServiceUserMatches(auth, this.userId);
    const startedAt = Date.now();
    let purgedCount = 0;
    let purgedBytes = 0;
    await this.db.withUserWriteTx(this.userId, async (tx) => {
      const purged = await this.trashRepo.purgeUserTrash(auth.user_id, tx);
      if (purged.nodes.length === 0) return;
      purgedCount = purged.nodes.length;

      const totalSize = purged.revisions.reduce((sum, r) => sum + r.size, 0);
      purgedBytes = totalSize;
      if (totalSize > 0) {
        await this.quota.updateBytesUsed(auth.user_id, -totalSize, tx);
      }

      // Purge is audit-only; lifecycle goes to structured logger
      // (aggregated counts below, no per-node row).
    });

    // Observability: track wall-clock duration.
    logInfo("file_service", "purge_all_trash", {
      userId: auth.user_id,
      purgedCount,
      purgedBytes,
      durationMs: Date.now() - startedAt,
    });

    return { ok: true };
  }

  // ---- MOVE/RENAME --------------------------------------------------------

  async moveFile(
    auth: AuthContext,
    srcRawPath: string,
    destRawPath: string,
  ): Promise<
    FileResult<
      MoveFileResult,
      | "invalid_source_path"
      | "invalid_dest_path"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "cycle"
    >
  > {
    assertServiceUserMatches(auth, this.userId);
    const srcParsed = this.parseRawPath(srcRawPath, auth);
    if (!srcParsed.ok) return { ok: false, code: "invalid_source_path" };
    const srcSegments = srcParsed.segments;
    if (srcSegments.length === 0)
      return { ok: false, code: "invalid_source_path" };
    const destParsed = this.parseRawPath(destRawPath, auth);
    if (!destParsed.ok) return { ok: false, code: "invalid_dest_path" };
    const destSegments = destParsed.segments;
    if (destSegments.length === 0)
      return { ok: false, code: "invalid_dest_path" };

    const srcFilePath = `/${srcSegments.join("/")}`;
    if (!this.authz.checkAbsolutePath(auth, srcFilePath, "write"))
      return { ok: false, code: "forbidden" };

    const destFilePath = `/${destSegments.join("/")}`;
    if (!this.authz.checkAbsolutePath(auth, destFilePath, "write"))
      return { ok: false, code: "forbidden" };

    const destParentSegments = destSegments.slice(0, -1);

    const txResult = await this.db
      .withUserWriteTx(this.userId, async (tx) => {
        const srcNodeId = await this.repo.resolvePath(
          auth.user_id,
          srcSegments,
          tx,
        );
        if (!srcNodeId) throw new TxRollbackError("not_found" as const);

        const destExisting = await this.repo.resolvePath(
          auth.user_id,
          destSegments,
          tx,
        );
        if (destExisting) throw new TxRollbackError("conflict" as const);

        const destName = destSegments[destSegments.length - 1];
        const destParentId =
          destParentSegments.length > 0
            ? await this.repo.ensureDirectoryPath(
                auth.user_id,
                destParentSegments,
                tx,
              )
            : "";

        const srcNode = await this.repo.getNode(auth.user_id, srcNodeId, tx);

        const moved = await this.repo.moveNode(
          auth.user_id,
          srcNodeId,
          destParentId,
          destName,
          tx,
        );
        if (!moved) throw new TxRollbackError("not_found" as const);

        return {
          ok: true as const,
          nodeId: srcNodeId,
          contentVersion: srcNode?.contentVersion ?? 0,
        };
      })
      .catch((e: unknown) => {
        if (
          e instanceof Error &&
          e.message.includes("Cannot move a directory into its own subtree")
        ) {
          return { ok: false as const, code: "cycle" as const };
        }
        return TxRollbackError.into<"not_found" | "conflict">(e);
      });

    return txResult;
  }

  // ---- REPLACE (file → file overwrite) ------------------------------------

  /**
   * Replace dst's content with src's content, preserving dst's identity and
   * version history. Src is soft-deleted after the operation.
   * Only file → file is allowed (no directories).
   */
  async replaceFile(
    auth: AuthContext,
    srcRawPath: string,
    destRawPath: string,
  ): Promise<
    FileResult<
      ReplaceFileResult,
      | "invalid_source_path"
      | "invalid_dest_path"
      | "forbidden"
      | "not_found"
      | "type_mismatch"
      | "quota_exceeded"
      | "conflict"
    >
  > {
    assertServiceUserMatches(auth, this.userId);
    const srcParsed = this.parseRawPath(srcRawPath, auth);
    if (!srcParsed.ok) return { ok: false, code: "invalid_source_path" };
    const srcSegments = srcParsed.segments;
    if (srcSegments.length === 0)
      return { ok: false, code: "invalid_source_path" };
    const destParsed = this.parseRawPath(destRawPath, auth);
    if (!destParsed.ok) return { ok: false, code: "invalid_dest_path" };
    const destSegments = destParsed.segments;
    if (destSegments.length === 0)
      return { ok: false, code: "invalid_dest_path" };

    const srcFilePath = `/${srcSegments.join("/")}`;
    const destFilePath = `/${destSegments.join("/")}`;

    if (!this.authz.checkAbsolutePath(auth, srcFilePath, "write"))
      return { ok: false, code: "forbidden" };
    if (!this.authz.checkAbsolutePath(auth, destFilePath, "write"))
      return { ok: false, code: "forbidden" };

    const dbResult = await this.db.withUserTx(this.userId, async (tx) => {
      const srcNodeId = await this.repo.resolvePath(
        auth.user_id,
        srcSegments,
        tx,
      );
      if (!srcNodeId) return { ok: false as const, code: "not_found" as const };
      const srcNode = await this.repo.getNode(auth.user_id, srcNodeId, tx);
      if (!srcNode) return { ok: false as const, code: "not_found" as const };

      const destNodeId = await this.repo.resolvePath(
        auth.user_id,
        destSegments,
        tx,
      );
      if (!destNodeId)
        return { ok: false as const, code: "not_found" as const };
      const destNode = await this.repo.getNode(auth.user_id, destNodeId, tx);
      if (!destNode) return { ok: false as const, code: "not_found" as const };

      // Both must be files
      if (srcNode.isDirectory || destNode.isDirectory)
        return { ok: false as const, code: "type_mismatch" as const };

      // Same node is a no-op conflict
      if (srcNode.id === destNode.id)
        return { ok: false as const, code: "conflict" as const };

      return { ok: true as const, srcNode, destNode };
    });
    if (!dbResult.ok) return dbResult;
    const { srcNode, destNode } = dbResult;

    // Read src content (storage I/O outside tx)
    if (!srcNode.storagePrefix || srcNode.chunkCount === null) {
      return { ok: false, code: "not_found" };
    }

    if (!srcNode.revisionId) return { ok: false, code: "not_found" };
    const obj = await this.storage.get(
      srcNode.storagePrefix,
      srcNode.chunkCount,
      srcNode.size ?? 0,
      srcNode.id,
    );
    if (!obj) return { ok: false, code: "not_found" };
    const body = await new Response(obj.body).arrayBuffer();

    // Pre-flight quota check (full new_size, not net increase).
    // Inside a user-scoped tx so user_limits / user_storage reads obey RLS.
    // storage write happens after — quota is the cheaper check.
    const quotaCheck = await this.db.withUserTx(this.userId, (tx) =>
      this.quota.checkStorage(auth.user_id, body.byteLength, tx),
    );
    if (!quotaCheck.allowed) return { ok: false, code: "quota_exceeded" };

    // Write to dst as new revision
    const attemptId = generateUlidForApi();
    const revisionId = generateUlidForApi();
    const { chunkCount, storagePrefix, size, hash } = await this.storage.put(
      destNode.id,
      attemptId,
      body,
    );

    // Atomic: commit revision on dst + soft-delete src
    // commitRevision throws TxRollbackError on conflict → triggers ROLLBACK
    const txResult = await this.db
      .withUserWriteTx(this.userId, async (tx) => {
        const commitResult = await this.commitRevision(
          {
            userId: auth.user_id,
            nodeId: destNode.id,
            revisionId,
            revision: {
              storagePrefix,
              contentType: srcNode.contentType,
              chunkCount,
              size,
              hash,
            },
            contentVersionCas: destNode.contentVersion,
            oldSize: destNode.size ?? 0,
          },
          tx,
        );

        // Soft-delete src
        await this.trashRepo.softDeleteNode(auth.user_id, srcNode.id, tx);

        return {
          ok: true as const,
          contentVersion: commitResult.contentVersion,
          prunedRevisions: commitResult.prunedRevisions,
        };
      })
      .catch((e: unknown) => {
        // Tx rolled back after the storage PUT, so no file_revisions
        // row exists yet — enqueue a tombstone manually so storage-gc can
        // reap the orphan chunks.
        enqueueStorageTombstone(this.db, storagePrefix).catch((enqErr) => {
          logWarn(
            "file_service.move",
            "tombstone_enqueue_failed",
            { storagePrefix },
            enqErr,
          );
        });
        return TxRollbackError.into<"conflict" | "quota_exceeded">(e);
      });

    if (!txResult.ok) return txResult;

    return {
      ok: true,
      nodeId: destNode.id,
      contentVersion: txResult.contentVersion,
    };
  }

  // ---- MKDIR --------------------------------------------------------------

  async mkdir(
    auth: AuthContext,
    rawPath: string,
  ): Promise<
    FileResult<MkdirResult, "invalid_path" | "forbidden" | "conflict">
  > {
    assertServiceUserMatches(auth, this.userId);
    const parsed = this.parseRawPath(rawPath, auth);
    if (!parsed.ok) return { ok: false, code: "invalid_path" };
    const segments = parsed.segments;
    if (segments.length === 0) return { ok: false, code: "invalid_path" };

    const dirPath = `/${segments.join("/")}`;
    if (!this.authz.checkAbsolutePath(auth, dirPath, "write"))
      return { ok: false, code: "forbidden" };

    // Single tx: existence check + ensureDirectoryPath.
    const result = await this.db
      .withUserWriteTx(this.userId, async (tx) => {
        const existing = await this.repo.resolvePath(
          auth.user_id,
          segments,
          tx,
        );
        if (existing) throw new TxRollbackError("conflict" as const);

        const nodeId = await this.repo.ensureDirectoryPath(
          auth.user_id,
          segments,
          tx,
        );
        return { ok: true as const, nodeId };
      })
      .catch(TxRollbackError.into<"conflict">);

    return result;
  }

  // ---- COPY ---------------------------------------------------------------

  async copyFile(
    auth: AuthContext,
    srcRawPath: string,
    destRawPath: string,
    overwrite: boolean,
  ): Promise<
    FileResult<
      PutFileResult,
      | "invalid_source_path"
      | "invalid_dest_path"
      | "forbidden"
      | "not_found"
      | "not_implemented"
      | "quota_exceeded"
      | "conflict"
      | "invalid_path" // from putFile (unreachable: destRawPath already validated above)
    >
  > {
    assertServiceUserMatches(auth, this.userId);
    const srcParsed = this.parseRawPath(srcRawPath, auth);
    if (!srcParsed.ok) return { ok: false, code: "invalid_source_path" };
    const srcSegments = srcParsed.segments;
    if (srcSegments.length === 0)
      return { ok: false, code: "invalid_source_path" };
    const destParsed = this.parseRawPath(destRawPath, auth);
    if (!destParsed.ok) return { ok: false, code: "invalid_dest_path" };
    const destSegments = destParsed.segments;
    if (destSegments.length === 0)
      return { ok: false, code: "invalid_dest_path" };

    // Read src + decide directory rejection in a read-only tx. Dest existence
    // is NOT checked here: the check + write must happen inside the same
    // writer tx (per-user advisory lock) to honor `overwrite=false` against
    // a concurrent putFile/mkdir on the same dest. putFile re-checks via
    // `ifNotExists` below.
    const dbResult = await this.db.withUserTx(this.userId, async (tx) => {
      const r = await this.resolveAndCheckRead(auth, srcSegments, tx);
      if (!r.ok) return r;
      if (r.node.isDirectory) {
        return { ok: false as const, code: "not_implemented" as const };
      }
      return { ok: true as const, node: r.node };
    });
    if (!dbResult.ok) return dbResult;
    const srcNode = dbResult.node;

    if (!srcNode.storagePrefix || srcNode.chunkCount === null) {
      return { ok: false, code: "not_found" };
    }

    if (!srcNode.revisionId) return { ok: false, code: "not_found" };
    const obj = await this.storage.get(
      srcNode.storagePrefix,
      srcNode.chunkCount,
      srcNode.size ?? 0,
      srcNode.id,
    );
    if (!obj) return { ok: false, code: "not_found" };
    const body = await new Response(obj.body).arrayBuffer();

    return this.putFile(auth, destRawPath, body, srcNode.contentType, {
      ifNotExists: !overwrite,
    });
  }

  // ---- COPY TREE (recursive directory copy) -------------------------------

  /**
   * Recursive copy of a directory subtree.
   *
   * Non-atomic by contract: the walk is performed as a sequence of
   * `mkdir` / `putFile` calls under the user-scoped transactional model of
   * each primitive. Already-copied entries are not rolled back on a
   * later-step failure — instead, the failure is reported alongside the list
   * of entries that did succeed (see `CopyTreeFail.entries`).
   *
   * History-preserving overwrite: when an existing destination file is hit
   * with `overwrite=true`, `putFile` is invoked which appends a new
   * revision on the existing node. The destination node identity and
   * version history are preserved. This is a deliberate divergence from
   * the WebDAV transport-layer "DELETE dest, then recreate" pattern in
   * `app/lib/gateway/dav.ts:handleCopy`.
   *
   * Source must be a directory; pass single files through `copyFile`
   * instead. Reject with `type_mismatch` if `destRawPath` exists as a file
   * (cannot merge a directory into a file).
   */
  async copyTree(
    auth: AuthContext,
    srcRawPath: string,
    destRawPath: string,
    overwrite: boolean,
  ): Promise<CopyTreeResult> {
    assertServiceUserMatches(auth, this.userId);
    const entries: CopyTreeEntryResult[] = [];

    const srcParsed = this.parseRawPath(srcRawPath, auth);
    if (!srcParsed.ok)
      return { ok: false, code: "invalid_source_path", entries };
    const srcSegments = srcParsed.segments;
    if (srcSegments.length === 0)
      return { ok: false, code: "invalid_source_path", entries };

    const destParsed = this.parseRawPath(destRawPath, auth);
    if (!destParsed.ok)
      return { ok: false, code: "invalid_dest_path", entries };
    const destSegments = destParsed.segments;
    if (destSegments.length === 0)
      return { ok: false, code: "invalid_dest_path", entries };

    // Reject copying a directory into its own subtree (would infinite-loop).
    const srcAbs = `/${srcSegments.join("/")}`;
    const destAbs = `/${destSegments.join("/")}`;
    if (destAbs === srcAbs || destAbs.startsWith(`${srcAbs}/`)) {
      return { ok: false, code: "cycle", entries };
    }

    // Validate source: must exist, must be a directory, must be readable.
    const srcResolved = await this.db.withUserTx(this.userId, (tx) =>
      this.resolveAndCheckRead(auth, srcSegments, tx),
    );
    if (!srcResolved.ok) {
      return {
        ok: false,
        code: srcResolved.code === "forbidden" ? "forbidden" : "not_found",
        entries,
      };
    }
    if (!srcResolved.node.isDirectory) {
      // Single-file copies belong to `copyFile`. Surface as type_mismatch so
      // callers know to dispatch on stat first.
      return { ok: false, code: "type_mismatch", entries };
    }

    // Validate destination root authorization (we'll check per-descendant
    // paths again as we walk, but a fast-fail at the root improves error
    // messages and avoids partial mkdir).
    if (!this.authz.checkAbsolutePath(auth, destAbs, "write")) {
      return { ok: false, code: "forbidden", entries };
    }

    // Check destination root state. We tolerate "destination dir already
    // exists" when overwrite=true (merge semantics) and "destination does
    // not exist yet" always. A destination file is type_mismatch.
    const destStat = await this.statPath(auth, destRawPath);
    if (destStat.ok) {
      if (!destStat.isDirectory) {
        return { ok: false, code: "type_mismatch", entries };
      }
      if (!overwrite) {
        return { ok: false, code: "conflict", entries };
      }
    } else if (destStat.code === "forbidden") {
      return { ok: false, code: "forbidden", entries };
    } else if (destStat.code === "invalid_path") {
      return { ok: false, code: "invalid_dest_path", entries };
    }
    // destStat.code === "not_found" is fine — mkdir will create it.

    return this.copyTreeWalk(
      auth,
      srcSegments,
      destSegments,
      overwrite,
      entries,
    );
  }

  /**
   * DFS over the source subtree, mirroring each directory and file into the
   * destination via `mkdir` / `putFile`. Returns on the first failure with
   * the partial-success list populated. storage I/O (PUT for each file body) is
   * unavoidable here — the work is bounded by the source subtree size.
   */
  private async copyTreeWalk(
    auth: AuthContext,
    srcSegments: string[],
    destSegments: string[],
    overwrite: boolean,
    entries: CopyTreeEntryResult[],
  ): Promise<CopyTreeResult> {
    const srcPath = `/${srcSegments.join("/")}`;
    const destPath = `/${destSegments.join("/")}`;

    // mkdir at destPath. Idempotent on conflict (already-a-directory branch
    // is allowed in the merge case; mkdir returns conflict if a *file* is
    // at the path, but we pre-checked that above for the root and the
    // pre-check is re-evaluated for each child below.)
    const mkdirRes = await this.mkdir(auth, destPath);
    let mkdirExisted = false;
    if (!mkdirRes.ok) {
      if (mkdirRes.code === "conflict") {
        // Already exists. Confirm it's a directory; otherwise type_mismatch.
        const stat = await this.statPath(auth, destPath);
        if (!stat.ok) {
          // `invalid_path` is unreachable here (destPath was constructed
          // from already-validated segments), but funnel it through the
          // typed union without dropping context.
          const code: CopyTreeError =
            stat.code === "invalid_path"
              ? "invalid_dest_path"
              : stat.code === "forbidden"
                ? "forbidden"
                : "not_found";
          return {
            ok: false,
            code,
            failedAtSrc: srcPath,
            failedAtDest: destPath,
            entries,
          };
        }
        if (!stat.isDirectory) {
          return {
            ok: false,
            code: "type_mismatch",
            failedAtSrc: srcPath,
            failedAtDest: destPath,
            entries,
          };
        }
        mkdirExisted = true;
        entries.push({
          kind: "directory",
          srcPath,
          destPath,
          nodeId: stat.nodeId,
          existed: true,
        });
      } else {
        // mkdir surfaces { invalid_path, forbidden, conflict }. invalid_path
        // is unreachable here (constructed segments) but funnel defensively.
        const code: CopyTreeError =
          mkdirRes.code === "invalid_path"
            ? "invalid_dest_path"
            : mkdirRes.code === "forbidden"
              ? "forbidden"
              : "conflict";
        return {
          ok: false,
          code,
          failedAtSrc: srcPath,
          failedAtDest: destPath,
          entries,
        };
      }
    } else {
      entries.push({
        kind: "directory",
        srcPath,
        destPath,
        nodeId: mkdirRes.nodeId,
        existed: false,
      });
    }
    void mkdirExisted;

    // List source children and recurse / copy file content per entry.
    const list = await this.listDirectory(auth, srcPath);
    if (!list.ok) {
      return {
        ok: false,
        code: list.code === "invalid_path" ? "invalid_source_path" : list.code,
        failedAtSrc: srcPath,
        failedAtDest: destPath,
        entries,
      };
    }

    for (const child of list.items) {
      const childSrcSegments = [...srcSegments, child.name];
      const childDestSegments = [...destSegments, child.name];
      const childSrcPath = `/${childSrcSegments.join("/")}`;
      const childDestPath = `/${childDestSegments.join("/")}`;

      if (child.isDirectory) {
        const subResult = await this.copyTreeWalk(
          auth,
          childSrcSegments,
          childDestSegments,
          overwrite,
          entries,
        );
        if (!subResult.ok) return subResult;
        // entries already updated in place by the recursive call
        continue;
      }

      // File: copy by GET + PUT (history-preserving — putFile creates a new
      // revision on overwrite). Reuses the storage primitive shared with
      // copyFile so chunked storage handling is identical.
      //
      // Guard against a dest path that already exists as a *directory*:
      // putFile would otherwise attach a revision to the dir node, which
      // is rejected by the chk_file_nodes_dir_no_revision DB constraint
      // and surfaces as an opaque tx failure (no orphan written — the
      // constraint fires before commit — but the caller can't reason about
      // which child failed). Stat dest up-front and return type_mismatch
      // so the partial-success contract holds.
      const childDestStat = await this.statPath(auth, childDestPath);
      if (childDestStat.ok && childDestStat.isDirectory) {
        return {
          ok: false,
          code: "type_mismatch",
          failedAtSrc: childSrcPath,
          failedAtDest: childDestPath,
          entries,
        };
      }

      const copyRes = await this.copyFile(
        auth,
        childSrcPath,
        childDestPath,
        overwrite,
      );
      if (!copyRes.ok) {
        // copyFile may surface invalid_path on dest segments; that should
        // never happen here because we constructed them ourselves, but
        // funnel through the typed union without dropping the code.
        const mapped = copyRes.code;
        const code: CopyTreeError =
          mapped === "invalid_source_path" ||
          mapped === "invalid_dest_path" ||
          mapped === "forbidden" ||
          mapped === "not_found" ||
          mapped === "conflict" ||
          mapped === "quota_exceeded"
            ? mapped
            : mapped === "invalid_path"
              ? "invalid_dest_path"
              : "type_mismatch"; // not_implemented falls here defensively
        return {
          ok: false,
          code,
          failedAtSrc: childSrcPath,
          failedAtDest: childDestPath,
          entries,
        };
      }

      entries.push({
        kind: "file",
        srcPath: childSrcPath,
        destPath: childDestPath,
        nodeId: copyRes.nodeId,
        size: copyRes.size,
        hash: copyRes.hash,
        contentVersion: copyRes.contentVersion,
        existed: copyRes.existed,
      });
    }

    return { ok: true, entries };
  }

  // ---- Private helpers ----------------------------------------------------

  private parseRawPath(
    rawPath: string,
    auth: AuthContext,
  ): { ok: true; segments: string[] } | { ok: false } {
    const result = parseClientPath(rawPath, auth);
    if (!result.ok) return { ok: false };
    return result;
  }

  private async resolveAndCheckRead(
    auth: AuthContext,
    segments: string[],
    tx: WithinUserTx,
  ): Promise<FileResult<{ node: FileNode }, "forbidden" | "not_found">> {
    const filePath = `/${segments.join("/")}`;
    if (!this.authz.checkAbsolutePath(auth, filePath, "read"))
      return { ok: false, code: "forbidden" };

    const nodeId = await this.repo.resolvePath(auth.user_id, segments, tx);
    if (!nodeId) return { ok: false, code: "not_found" };

    const node = await this.repo.getNode(auth.user_id, nodeId, tx);
    if (!node) return { ok: false, code: "not_found" };

    return { ok: true, node };
  }

  /**
   * Returns true if segments represent the token's base_path root directory.
   * Used to allow listing an empty base_path directory before any files exist.
   */
  private isBasepathRoot(auth: AuthContext, segments: string[]): boolean {
    if (auth.type !== "token" || !auth.base_path || auth.base_path === "/") {
      return false;
    }
    const baseSegments = auth.base_path.split("/").filter(Boolean);
    if (baseSegments.length !== segments.length) return false;
    return baseSegments.every((seg, i) => seg === segments[i]);
  }

  private actor(auth: AuthContext): FileActor {
    return auth.type === "token" ? "token" : "web";
  }
}
