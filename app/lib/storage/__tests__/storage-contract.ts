import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "../adapter";

interface StorageContract {
  create(): StorageAdapter | Promise<StorageAdapter>;
}

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

async function textFrom(
  adapter: StorageAdapter,
  key: string,
): Promise<string | null> {
  const object = await adapter.get(key);
  if (!object) return null;
  return await new Response(object.body).text();
}

export function describeStorageAdapterContract(
  name: string,
  contract: StorageContract,
): void {
  describe(`${name} StorageAdapter contract`, () => {
    it("puts and gets content", async () => {
      const storage = await contract.create();

      await storage.put("objects/a.txt", bytes("hello"));

      expect(await textFrom(storage, "objects/a.txt")).toBe("hello");
    });

    it("stores empty objects", async () => {
      const storage = await contract.create();

      await storage.put("objects/empty.bin", new ArrayBuffer(0));

      expect(await textFrom(storage, "objects/empty.bin")).toBe("");
      expect(await storage.head("objects/empty.bin")).toEqual({ size: 0 });
    });

    it("returns null for missing objects", async () => {
      const storage = await contract.create();

      expect(await storage.get("objects/missing.bin")).toBeNull();
      expect(await storage.head("objects/missing.bin")).toBeNull();
    });

    it("overwrites existing keys", async () => {
      const storage = await contract.create();

      await storage.put("objects/item.bin", bytes("old"));
      await storage.put("objects/item.bin", bytes("newer"));

      expect(await textFrom(storage, "objects/item.bin")).toBe("newer");
      expect(await storage.head("objects/item.bin")).toEqual({ size: 5 });
    });

    it("deletes existing and missing keys idempotently", async () => {
      const storage = await contract.create();

      await storage.put("objects/item.bin", bytes("body"));
      await storage.delete("objects/item.bin");
      await storage.delete("objects/item.bin");

      expect(await storage.get("objects/item.bin")).toBeNull();
    });

    it("deletes many keys with missing keys as no-ops", async () => {
      const storage = await contract.create();

      await storage.deleteMany([]);
      await storage.put("objects/a.bin", bytes("a"));
      await storage.put("objects/b.bin", bytes("b"));
      await storage.put("objects/c.bin", bytes("c"));
      await storage.deleteMany([
        "objects/a.bin",
        "objects/missing.bin",
        "objects/c.bin",
      ]);

      expect((await storage.list("objects/")).map((item) => item.key)).toEqual([
        "objects/b.bin",
      ]);
    });

    it("lists a missing prefix as empty", async () => {
      const storage = await contract.create();

      expect(await storage.list("missing/")).toEqual([]);
    });

    it("lists keys under a slash-terminated prefix in lexical order", async () => {
      const storage = await contract.create();

      await storage.put("objects/b.txt", bytes("b"));
      await storage.put("other/c.txt", bytes("c"));
      await storage.put("objects/a.txt", bytes("a"));
      await storage.put("objects/nested/d.txt", bytes("d"));

      expect((await storage.list("objects/")).map((item) => item.key)).toEqual([
        "objects/a.txt",
        "objects/b.txt",
        "objects/nested/d.txt",
      ]);
    });

    it("rejects unsafe keys and prefixes", async () => {
      const storage = await contract.create();

      await expect(storage.put("../escape.bin", bytes("x"))).rejects.toThrow(
        "Invalid storage key",
      );
      await expect(storage.get("/absolute.bin")).rejects.toThrow(
        "Invalid storage key",
      );
      await expect(storage.delete("objects/../escape.bin")).rejects.toThrow(
        "Invalid storage key",
      );
      await expect(storage.put(".tmp/orphan.bin", bytes("x"))).rejects.toThrow(
        "Invalid storage key",
      );
      await expect(storage.list("objects")).rejects.toThrow(
        "Invalid storage prefix",
      );
    });
  });
}
