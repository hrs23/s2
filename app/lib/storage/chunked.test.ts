import { beforeEach, describe, expect, it } from "vitest";
import { CHUNK_SIZE, ChunkedStorage } from "./chunked.server";
import { MemoryStorageAdapter } from "./memory.server";

const USER_ID = "user_chunked_test";

let raw: MemoryStorageAdapter;
let storage: ChunkedStorage;

beforeEach(() => {
  raw = new MemoryStorageAdapter();
  storage = new ChunkedStorage(raw, USER_ID);
});

describe("ChunkedStorage", () => {
  it("puts and gets a small file", async () => {
    const nodeId = "node1";
    const body = new TextEncoder().encode("hello world").buffer as ArrayBuffer;

    const { chunkCount, storagePrefix, size, hash } = await storage.put(
      nodeId,
      "attempt1",
      body,
    );

    expect(chunkCount).toBe(1);
    expect(size).toBe(body.byteLength);
    expect(hash).toHaveLength(64); // SHA-256 hex
    expect(storagePrefix).toBe(`${USER_ID}/${nodeId}/u/attempt1`);

    const result = await storage.get(storagePrefix, chunkCount, size, nodeId);
    expect(result).not.toBeNull();
    const text = await new Response(result?.body).text();
    expect(text).toBe("hello world");
    expect(result?.size).toBe(body.byteLength);
  });

  it("stores each chunk as a separate object", async () => {
    const nodeId = "node2";
    const body = new Uint8Array(10).buffer as ArrayBuffer;
    const { storagePrefix, chunkCount } = await storage.put(
      nodeId,
      "att2",
      body,
    );
    expect(chunkCount).toBe(1);
    const listed = await raw.list(`${storagePrefix}/`);
    expect(listed).toHaveLength(1);
  });

  it("returns null if any chunk is missing", async () => {
    const nodeId = "node3";
    const body = new TextEncoder().encode("test").buffer as ArrayBuffer;
    const { storagePrefix, size } = await storage.put(nodeId, "att3", body);

    await raw.delete(`${storagePrefix}/c/00000`);

    const result = await storage.get(storagePrefix, 1, size, nodeId);
    expect(result).toBeNull();
  });

  it("throws on size mismatch (truncation)", async () => {
    const nodeId = "node4";
    const body = new TextEncoder().encode("hello").buffer as ArrayBuffer;
    const { storagePrefix, chunkCount } = await storage.put(
      nodeId,
      "att4",
      body,
    );

    const result = await storage.get(storagePrefix, chunkCount, 999, nodeId);
    expect(result).not.toBeNull();
    await expect(new Response(result?.body).arrayBuffer()).rejects.toThrow(
      "Size mismatch",
    );
  });

  it("puts and gets an empty file (0 bytes)", async () => {
    const nodeId = "node_empty";
    const body = new ArrayBuffer(0);

    const { chunkCount, storagePrefix, size, hash } = await storage.put(
      nodeId,
      "att_empty",
      body,
    );

    expect(chunkCount).toBe(0);
    expect(size).toBe(0);
    expect(hash).toHaveLength(64);

    const listed = await raw.list(`${storagePrefix}/`);
    expect(listed).toHaveLength(0);

    const result = await storage.get(storagePrefix, chunkCount, size, nodeId);
    expect(result).not.toBeNull();
    expect(result?.size).toBe(0);
    const content = await new Response(result?.body).arrayBuffer();
    expect(content.byteLength).toBe(0);
  });

  describe("getRange", () => {
    function pattern(byteLength: number): ArrayBuffer {
      const buf = new Uint8Array(byteLength);
      for (let i = 0; i < byteLength; i++) buf[i] = i & 0xff;
      return buf.buffer;
    }

    async function putAndRange(
      nodeId: string,
      bodyLen: number,
      range: { offset: number; length: number },
    ) {
      const body = pattern(bodyLen);
      const { chunkCount, storagePrefix, size } = await storage.put(
        nodeId,
        `att_${nodeId}`,
        body,
      );
      const result = await storage.getRange(
        storagePrefix,
        chunkCount,
        size,
        nodeId,
        range,
      );
      return { result, body };
    }

    function expectedSlice(body: ArrayBuffer, offset: number, length: number) {
      return new Uint8Array(body.slice(offset, offset + length));
    }

    it("reads a range entirely within a single chunk", async () => {
      const { result, body } = await putAndRange("node_r1", 1024, {
        offset: 100,
        length: 50,
      });
      expect(result).not.toBeNull();
      expect(result?.offset).toBe(100);
      expect(result?.length).toBe(50);
      const bytes = new Uint8Array(
        await new Response(result?.body).arrayBuffer(),
      );
      expect(bytes).toEqual(expectedSlice(body, 100, 50));
    });

    it("reads a range starting at offset 0", async () => {
      const { result, body } = await putAndRange("node_r2", 1024, {
        offset: 0,
        length: 100,
      });
      const bytes = new Uint8Array(
        await new Response(result?.body).arrayBuffer(),
      );
      expect(bytes).toEqual(expectedSlice(body, 0, 100));
    });

    it("reads a range ending at the last byte (small file)", async () => {
      const { result, body } = await putAndRange("node_r3", 1000, {
        offset: 900,
        length: 100,
      });
      const bytes = new Uint8Array(
        await new Response(result?.body).arrayBuffer(),
      );
      expect(bytes).toEqual(expectedSlice(body, 900, 100));
    });

    it("reads a single byte (length=1)", async () => {
      const { result, body } = await putAndRange("node_r4", 1024, {
        offset: 512,
        length: 1,
      });
      const bytes = new Uint8Array(
        await new Response(result?.body).arrayBuffer(),
      );
      expect(bytes).toEqual(expectedSlice(body, 512, 1));
    });

    it("reads a range spanning two chunks (boundary crossing)", async () => {
      const { result, body } = await putAndRange("node_rb", CHUNK_SIZE + 100, {
        offset: CHUNK_SIZE - 50,
        length: 100,
      });
      expect(result?.offset).toBe(CHUNK_SIZE - 50);
      expect(result?.length).toBe(100);
      const bytes = new Uint8Array(
        await new Response(result?.body).arrayBuffer(),
      );
      expect(bytes).toEqual(expectedSlice(body, CHUNK_SIZE - 50, 100));
    });

    it("reads a range that lies entirely within a non-first chunk", async () => {
      const bodyLen = CHUNK_SIZE + 1000;
      const { result, body } = await putAndRange("node_rs", bodyLen, {
        offset: CHUNK_SIZE + 200,
        length: 500,
      });
      const bytes = new Uint8Array(
        await new Response(result?.body).arrayBuffer(),
      );
      expect(bytes).toEqual(expectedSlice(body, CHUNK_SIZE + 200, 500));
    });

    it("skips early chunks: does not fetch chunk 0 when range lies in chunk 1", async () => {
      const bodyLen = CHUNK_SIZE + 200;
      const body = pattern(bodyLen);
      const { chunkCount, storagePrefix, size } = await storage.put(
        "node_sk",
        "att_sk",
        body,
      );
      await raw.delete(`${storagePrefix}/c/00000`);
      const result = await storage.getRange(
        storagePrefix,
        chunkCount,
        size,
        "node_sk",
        { offset: CHUNK_SIZE + 50, length: 100 },
      );
      expect(result).not.toBeNull();
      const bytes = new Uint8Array(
        await new Response(result?.body).arrayBuffer(),
      );
      expect(bytes).toEqual(expectedSlice(body, CHUNK_SIZE + 50, 100));
    });

    it("reads the entire last (partial) chunk", async () => {
      const bodyLen = CHUNK_SIZE + 123;
      const { result, body } = await putAndRange("node_rl", bodyLen, {
        offset: CHUNK_SIZE,
        length: 123,
      });
      const bytes = new Uint8Array(
        await new Response(result?.body).arrayBuffer(),
      );
      expect(bytes).toEqual(expectedSlice(body, CHUNK_SIZE, 123));
    });

    it("reads a range exactly at a chunk boundary (offset = CHUNK_SIZE)", async () => {
      const bodyLen = CHUNK_SIZE + 1000;
      const { result, body } = await putAndRange("node_rcb", bodyLen, {
        offset: CHUNK_SIZE,
        length: 1000,
      });
      const bytes = new Uint8Array(
        await new Response(result?.body).arrayBuffer(),
      );
      expect(bytes).toEqual(expectedSlice(body, CHUNK_SIZE, 1000));
    });

    it("reads the full file as a range (offset=0, length=size)", async () => {
      const { result, body } = await putAndRange("node_rfull", 4096, {
        offset: 0,
        length: 4096,
      });
      const bytes = new Uint8Array(
        await new Response(result?.body).arrayBuffer(),
      );
      expect(bytes).toEqual(expectedSlice(body, 0, 4096));
    });

    it("returns null when the first required chunk is missing", async () => {
      const bodyLen = 1024;
      const body = pattern(bodyLen);
      const { chunkCount, storagePrefix, size } = await storage.put(
        "node_miss",
        "att_miss",
        body,
      );
      await raw.delete(`${storagePrefix}/c/00000`);
      const result = await storage.getRange(
        storagePrefix,
        chunkCount,
        size,
        "node_miss",
        { offset: 0, length: 100 },
      );
      expect(result).toBeNull();
    });

    it("errors mid-stream when a needed non-first chunk is missing", async () => {
      const bodyLen = CHUNK_SIZE + 200;
      const body = pattern(bodyLen);
      const { chunkCount, storagePrefix, size } = await storage.put(
        "node_miss2",
        "att_miss2",
        body,
      );
      await raw.delete(`${storagePrefix}/c/00001`);
      const result = await storage.getRange(
        storagePrefix,
        chunkCount,
        size,
        "node_miss2",
        { offset: CHUNK_SIZE - 10, length: 100 },
      );
      expect(result).not.toBeNull();
      await expect(new Response(result?.body).arrayBuffer()).rejects.toThrow();
    });

    it("throws when range exceeds stored chunk count", async () => {
      const body = pattern(100);
      const { chunkCount, storagePrefix, size } = await storage.put(
        "node_bad_range",
        "att_bad",
        body,
      );
      expect(() =>
        storage.getRange(storagePrefix, chunkCount, size, "node_bad_range", {
          offset: 0,
          length: CHUNK_SIZE + 1,
        }),
      ).rejects.toThrow(/Range exceeds stored chunks/);
    });

    it("errors on chunk size mismatch within range stream", async () => {
      const bodyLen = CHUNK_SIZE + 100;
      const body = pattern(bodyLen);
      const { chunkCount, storagePrefix, size } = await storage.put(
        "node_trunc",
        "att_trunc",
        body,
      );
      // Replace chunk 0 with a shorter blob to trigger per-chunk size check.
      await raw.put(`${storagePrefix}/c/00000`, new ArrayBuffer(100));
      const result = await storage.getRange(
        storagePrefix,
        chunkCount,
        size,
        "node_trunc",
        { offset: 0, length: 50 },
      );
      expect(result).not.toBeNull();
      await expect(new Response(result?.body).arrayBuffer()).rejects.toThrow(
        /Chunk 0 size mismatch/,
      );
    });
  });
});
