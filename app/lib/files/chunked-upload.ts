// Client-side chunked upload using Upload Session API.
// For files larger than CHUNKED_THRESHOLD, splits the file into chunks
// and uploads them sequentially via the Upload Session API.

import { api } from "~/lib/api";

/** Files larger than 4 MB use chunked upload */
export const CHUNKED_THRESHOLD = 4 * 1024 * 1024;

interface UploadProgress {
  /** Bytes uploaded so far */
  loaded: number;
  /** Total file size */
  total: number;
  /** 0–1 fraction */
  percent: number;
}

export type ProgressCallback = (progress: UploadProgress) => void;

type FileUploadStatus = "pending" | "uploading" | "done" | "failed";

export interface FileUploadEntry {
  name: string;
  status: FileUploadStatus;
  loaded: number;
  total: number;
  error?: string;
}

export interface MultiUploadState {
  files: FileUploadEntry[];
  currentIndex: number;
}

/**
 * Upload a file using chunked upload session.
 * Splits the file, uploads chunks sequentially, then completes the session.
 * Cancels the session on error.
 */
async function chunkedUpload(
  path: string,
  file: File,
  onProgress?: ProgressCallback,
): Promise<void> {
  const totalSize = file.size;

  const session = await api.uploads.create(path, totalSize);
  const chunkSize = session.chunkSize;
  const totalChunks = Math.ceil(totalSize / chunkSize);

  let uploaded = 0;

  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalSize);
      const chunk = file.slice(start, end);
      const buf = await chunk.arrayBuffer();

      await api.uploads.uploadChunk(session.sessionId, i, buf);

      uploaded += buf.byteLength;
      onProgress?.({
        loaded: uploaded,
        total: totalSize,
        percent: uploaded / totalSize,
      });
    }

    await api.uploads.complete(session.sessionId);
  } catch (err) {
    // Best-effort cancel on failure
    await api.uploads.cancel(session.sessionId).catch(() => {});
    throw err;
  }
}

/**
 * Upload a file — automatically picks single PUT or chunked upload session.
 */
export async function uploadFile(
  path: string,
  file: File,
  onProgress?: ProgressCallback,
): Promise<void> {
  if (file.size > CHUNKED_THRESHOLD) {
    await chunkedUpload(path, file, onProgress);
  } else {
    const buf = await file.arrayBuffer();
    await api.files.upload(path, buf);
    onProgress?.({ loaded: file.size, total: file.size, percent: 1 });
  }
}
