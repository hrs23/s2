import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHUNKED_THRESHOLD, uploadFile } from "./chunked-upload";

// Mock the api module
vi.mock("~/lib/api", () => ({
  api: {
    files: {
      upload: vi.fn().mockResolvedValue({}),
    },
    uploads: {
      create: vi.fn().mockResolvedValue({
        sessionId: "sess-1",
        nodeId: "node-1",
        chunkSize: 4 * 1024 * 1024,
        expiresAt: "2099-01-01T00:00:00Z",
      }),
      uploadChunk: vi.fn().mockResolvedValue({
        chunkIndex: 0,
        size: 100,
        checksum: "abc",
      }),
      complete: vi.fn().mockResolvedValue({
        nodeId: "node-1",
        size: 100,
        chunkCount: 1,
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { api } from "~/lib/api";

function createFile(size: number, name = "test.bin"): File {
  const buf = new ArrayBuffer(size);
  return new File([buf], name, { type: "application/octet-stream" });
}

describe("uploadFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses single PUT for files <= CHUNKED_THRESHOLD", async () => {
    const file = createFile(1024);
    const onProgress = vi.fn();

    await uploadFile("docs/small.bin", file, onProgress);

    expect(api.files.upload).toHaveBeenCalledOnce();
    expect(api.files.upload).toHaveBeenCalledWith(
      "docs/small.bin",
      expect.any(ArrayBuffer),
    );
    expect(api.uploads.create).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith({
      loaded: 1024,
      total: 1024,
      percent: 1,
    });
  });

  it("uses chunked upload for files > CHUNKED_THRESHOLD", async () => {
    const size = CHUNKED_THRESHOLD + 1024;
    const file = createFile(size);
    const onProgress = vi.fn();

    await uploadFile("docs/large.bin", file, onProgress);

    expect(api.uploads.create).toHaveBeenCalledWith("docs/large.bin", size);
    expect(api.uploads.uploadChunk).toHaveBeenCalledTimes(2);
    expect(api.uploads.complete).toHaveBeenCalledWith("sess-1");
    expect(api.files.upload).not.toHaveBeenCalled();

    // Progress should be called for each chunk
    expect(onProgress).toHaveBeenCalledTimes(2);
    const lastCall = onProgress.mock.calls[1][0];
    expect(lastCall.percent).toBeCloseTo(1, 5);
  });

  it("cancels session on chunk upload error", async () => {
    vi.mocked(api.uploads.uploadChunk).mockRejectedValueOnce(
      new Error("network error"),
    );

    const file = createFile(CHUNKED_THRESHOLD + 1);

    await expect(uploadFile("fail.bin", file)).rejects.toThrow("network error");
    expect(api.uploads.cancel).toHaveBeenCalledWith("sess-1");
  });

  it("reports progress for each chunk", async () => {
    const chunkSize = CHUNKED_THRESHOLD;
    const size = chunkSize * 3;
    const file = createFile(size);
    const onProgress = vi.fn();

    await uploadFile("multi.bin", file, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(3);

    const calls = onProgress.mock.calls.map((c) => c[0]);
    expect(calls[0].loaded).toBe(chunkSize);
    expect(calls[1].loaded).toBe(chunkSize * 2);
    expect(calls[2].loaded).toBe(chunkSize * 3);
    expect(calls[2].percent).toBe(1);
  });
});
