// Chunked plaintext storage: splits files into 4MB chunks and stores them
// as individual objects on the storage backend.

import { sha256Hex } from "~/lib/crypto/hash.server";
import { logError } from "~/lib/observability/logger.server";
import type { StorageAdapter } from "./adapter";

export const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB per chunk

export interface PutChunkedResult {
  chunkCount: number;
  storagePrefix: string; // {userId}/{nodeId}/u/{attemptId}
  size: number; // plaintext size
  hash: string; // SHA-256 hex of plaintext
}

/** storage key for a chunk: {prefix}/c/{index:05d} */
function chunkKey(storagePrefix: string, chunkIndex: number): string {
  return `${storagePrefix}/c/${String(chunkIndex).padStart(5, "0")}`;
}

// This prefix shape is load-bearing — storage-gc derives the storage
// reap target from the tombstone row's storage_prefix, so any divergence
// between writers and the GC walker leaks chunks. Keep this as the single
// source of truth.
export function sessionStoragePrefix(
  userId: string,
  nodeId: string,
  sessionId: string,
): string {
  return `${userId}/${nodeId}/u/${sessionId}`;
}

/** Split ArrayBuffer into chunks of at most chunkSize bytes. */
function splitIntoChunks(body: ArrayBuffer, chunkSize: number): ArrayBuffer[] {
  const chunks: ArrayBuffer[] = [];
  let offset = 0;
  while (offset < body.byteLength) {
    chunks.push(body.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  return chunks;
}

export class ChunkedStorage {
  constructor(
    private raw: StorageAdapter,
    private userId: string,
  ) {}

  /**
   * Upload a file as plaintext chunks.
   * Returns metadata to store in Postgres.
   */
  async put(
    nodeId: string,
    attemptId: string,
    body: ArrayBuffer,
  ): Promise<PutChunkedResult> {
    const storagePrefix = sessionStoragePrefix(this.userId, nodeId, attemptId);
    const hash = await sha256Hex(body);

    const chunks = splitIntoChunks(body, CHUNK_SIZE);
    for (let i = 0; i < chunks.length; i++) {
      await this.raw.put(chunkKey(storagePrefix, i), chunks[i]);
    }

    return {
      chunkCount: chunks.length,
      storagePrefix,
      size: body.byteLength,
      hash,
    };
  }

  /**
   * Fetch a single chunk. If `prefetched` is provided, its body is consumed
   * instead of issuing a fresh raw.get (used for the pre-check first chunk).
   * Returns null if the chunk is missing in raw storage.
   */
  private async fetchChunk(
    storagePrefix: string,
    chunkIndex: number,
    prefetched?: { body: ReadableStream },
  ): Promise<ArrayBuffer | null> {
    let bodyStream: ReadableStream;
    if (prefetched) {
      bodyStream = prefetched.body;
    } else {
      const obj = await this.raw.get(chunkKey(storagePrefix, chunkIndex));
      if (!obj) return null;
      bodyStream = obj.body;
    }
    return await new Response(bodyStream).arrayBuffer();
  }

  /**
   * Build a ReadableStream that walks chunks [startChunk, endChunkInclusive]
   * and forwards plaintext bytes via `emit`.
   */
  private buildChunkStream(opts: {
    storagePrefix: string;
    startChunk: number;
    endChunkInclusive: number;
    firstObj: { body: ReadableStream };
    emit: (
      controller: ReadableStreamDefaultController<Uint8Array>,
      chunkIndex: number,
      plain: ArrayBuffer,
    ) => { ok: true; emitted: number } | { ok: false; error: Error };
    finalize: (
      bytesEmitted: number,
    ) => { ok: true } | { ok: false; error: Error };
    onError: (err: unknown) => void;
  }): ReadableStream {
    const self = this;
    const {
      storagePrefix,
      startChunk,
      endChunkInclusive,
      firstObj,
      emit,
      finalize,
      onError,
    } = opts;

    let next = startChunk;
    let bytesEmitted = 0;

    return new ReadableStream({
      async pull(controller) {
        try {
          if (next > endChunkInclusive) {
            const fin = finalize(bytesEmitted);
            if (!fin.ok) {
              controller.error(fin.error);
              return;
            }
            controller.close();
            return;
          }

          const plain = await self.fetchChunk(
            storagePrefix,
            next,
            next === startChunk ? firstObj : undefined,
          );
          if (plain === null) {
            controller.error(new Error(`Missing chunk ${next}`));
            return;
          }

          const r = emit(controller, next, plain);
          if (!r.ok) {
            controller.error(r.error);
            return;
          }
          bytesEmitted += r.emitted;
          next++;
        } catch (err) {
          onError(err);
          controller.error(err);
        }
      },
    });
  }

  /**
   * Download chunks as a stream.
   * Truncation detection: cumulative plaintext size must equal stored size.
   * Returns null if the first chunk is missing (file doesn't exist in storage).
   */
  async get(
    storagePrefix: string,
    chunkCount: number,
    size: number,
    nodeId: string,
  ): Promise<{ body: ReadableStream; size: number } | null> {
    // Empty files have no chunks — return an empty stream immediately
    if (chunkCount === 0) {
      return {
        body: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        size: 0,
      };
    }

    // Pre-check: verify first chunk exists before creating the stream
    const firstObj = await this.raw.get(chunkKey(storagePrefix, 0));
    if (!firstObj) return null;

    const expectedSize = size;
    const body = this.buildChunkStream({
      storagePrefix,
      startChunk: 0,
      endChunkInclusive: chunkCount - 1,
      firstObj,
      emit: (controller, _i, plain) => {
        controller.enqueue(new Uint8Array(plain));
        return { ok: true, emitted: plain.byteLength };
      },
      finalize: (bytesEmitted) => {
        if (bytesEmitted !== expectedSize) {
          return {
            ok: false,
            error: new Error(
              `Size mismatch: expected ${expectedSize}, got ${bytesEmitted}. Possible truncation.`,
            ),
          };
        }
        return { ok: true };
      },
      onError: (err) =>
        logError(
          "storage",
          "stream_failed",
          { nodeId, chunkCount, expectedSize },
          err,
        ),
    });

    return { body, size };
  }

  /**
   * Download a byte range as a stream.
   *
   * Preconditions (caller must validate):
   *   - `length > 0`
   *   - `offset >= 0`
   *   - `offset + length <= size`
   *
   * Returns null if a required first chunk is missing in storage.
   */
  async getRange(
    storagePrefix: string,
    chunkCount: number,
    size: number,
    nodeId: string,
    range: { offset: number; length: number },
  ): Promise<{ body: ReadableStream; offset: number; length: number } | null> {
    const { offset, length } = range;

    const startChunk = Math.floor(offset / CHUNK_SIZE);
    const endChunkInclusive = Math.floor((offset + length - 1) / CHUNK_SIZE);
    if (endChunkInclusive >= chunkCount) {
      throw new Error(
        `Range exceeds stored chunks: end chunk ${endChunkInclusive} >= chunkCount ${chunkCount} (offset=${offset}, length=${length}, size=${size})`,
      );
    }

    const firstObj = await this.raw.get(chunkKey(storagePrefix, startChunk));
    if (!firstObj) return null;

    const body = this.buildChunkStream({
      storagePrefix,
      startChunk,
      endChunkInclusive,
      firstObj,
      emit: (controller, i, plain) => {
        const chunkPlaintextStart = i * CHUNK_SIZE;
        const chunkPlaintextEnd = Math.min((i + 1) * CHUNK_SIZE, size);
        const chunkPlaintextLen = chunkPlaintextEnd - chunkPlaintextStart;

        if (plain.byteLength !== chunkPlaintextLen) {
          return {
            ok: false,
            error: new Error(
              `Chunk ${i} size mismatch: expected ${chunkPlaintextLen}, got ${plain.byteLength}. Possible truncation.`,
            ),
          };
        }

        const rangeStart = offset;
        const rangeEnd = offset + length; // exclusive
        const sliceFrom = Math.max(0, rangeStart - chunkPlaintextStart);
        const sliceTo = Math.min(
          chunkPlaintextLen,
          rangeEnd - chunkPlaintextStart,
        );
        const slice = new Uint8Array(plain).subarray(sliceFrom, sliceTo);
        controller.enqueue(slice);
        return { ok: true, emitted: slice.byteLength };
      },
      finalize: (bytesEmitted) => {
        if (bytesEmitted !== length) {
          return {
            ok: false,
            error: new Error(
              `Range size mismatch: expected ${length}, emitted ${bytesEmitted}.`,
            ),
          };
        }
        return { ok: true };
      },
      onError: (err) =>
        logError(
          "storage",
          "range_stream_failed",
          { nodeId, offset, length, size },
          err,
        ),
    });

    return { body, offset, length };
  }
}
