// @vitest-environment node
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeStorageAdapterContract } from "./__tests__/storage-contract";
import { FileSystemStorageAdapter } from "./filesystem.server";

let roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "s2-storage-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots = [];
});

describeStorageAdapterContract("FileSystemStorageAdapter", {
  async create() {
    return new FileSystemStorageAdapter(await makeRoot());
  },
});

describe("FileSystemStorageAdapter filesystem safety", () => {
  it("reports capacity for the filesystem containing the storage root", async () => {
    const root = await makeRoot();
    const storage = new FileSystemStorageAdapter(root);

    const availableBytes = await storage.availableBytes();

    expect(availableBytes).toBeGreaterThan(0);
  });

  it("does not leave temporary files after put", async () => {
    const root = await makeRoot();
    const storage = new FileSystemStorageAdapter(root);

    await storage.put("objects/a.bin", new TextEncoder().encode("a").buffer);

    expect(await readdir(path.join(root, ".tmp"))).toEqual([]);
  });

  it("removes empty object directories after deleteMany", async () => {
    const root = await makeRoot();
    const storage = new FileSystemStorageAdapter(root);

    await storage.put(
      "objects/nested/a.bin",
      new TextEncoder().encode("a").buffer,
    );
    await storage.deleteMany(["objects/nested/a.bin"]);

    expect(await storage.list("objects/")).toEqual([]);
  });
});
