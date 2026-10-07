import { describe, expect, it } from "vitest";
import { readDroppedItems } from "./dnd";

// Minimal mocks of the FileSystem API surface we use.
type MockEntry = MockFileEntry | MockDirEntry;

interface MockFileEntry {
  isFile: true;
  isDirectory: false;
  name: string;
  fullPath: string;
  file: (cb: (f: File) => void, err?: (e: Error) => void) => void;
}

interface MockDirEntry {
  isFile: false;
  isDirectory: true;
  name: string;
  fullPath: string;
  createReader: () => MockDirReader;
}

interface MockDirReader {
  // Browsers may return entries in batches; readEntries must be called
  // repeatedly until it returns []. We replicate that.
  readEntries: (
    cb: (entries: MockEntry[]) => void,
    err?: (e: Error) => void,
  ) => void;
}

function fileEntry(name: string, fullPath: string, body = name): MockFileEntry {
  const file = new File([body], name);
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath,
    file: (cb) => cb(file),
  };
}

function dirEntry(
  name: string,
  fullPath: string,
  children: MockEntry[],
): MockDirEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath,
    createReader: () => {
      let drained = false;
      return {
        readEntries: (cb) => {
          if (drained) {
            cb([]);
            return;
          }
          drained = true;
          cb(children);
        },
      };
    },
  };
}

function dataTransferOf(entries: MockEntry[]): DataTransfer {
  const items = entries.map((entry) => ({
    kind: "file" as const,
    webkitGetAsEntry: () => entry as unknown as FileSystemEntry,
  }));
  return {
    items: items as unknown as DataTransferItemList,
    files: [] as unknown as FileList,
  } as DataTransfer;
}

describe("readDroppedItems", () => {
  it("returns top-level files with their basename", async () => {
    const dt = dataTransferOf([
      fileEntry("a.txt", "/a.txt"),
      fileEntry("b.png", "/b.png"),
    ]);
    const result = await readDroppedItems(dt);
    expect(result.map((r) => r.relativePath)).toEqual(["a.txt", "b.png"]);
    expect(result[0].file.name).toBe("a.txt");
  });

  it("recurses into a folder and prefixes the folder name", async () => {
    const dt = dataTransferOf([
      dirEntry("photos", "/photos", [
        fileEntry("1.jpg", "/photos/1.jpg"),
        fileEntry("2.jpg", "/photos/2.jpg"),
      ]),
    ]);
    const result = await readDroppedItems(dt);
    expect(result.map((r) => r.relativePath).sort()).toEqual([
      "photos/1.jpg",
      "photos/2.jpg",
    ]);
  });

  it("recurses into nested folders", async () => {
    const dt = dataTransferOf([
      dirEntry("a", "/a", [
        dirEntry("b", "/a/b", [fileEntry("c.txt", "/a/b/c.txt")]),
        fileEntry("top.txt", "/a/top.txt"),
      ]),
    ]);
    const result = await readDroppedItems(dt);
    expect(result.map((r) => r.relativePath).sort()).toEqual([
      "a/b/c.txt",
      "a/top.txt",
    ]);
  });

  it("handles a mix of files and folders at top level", async () => {
    const dt = dataTransferOf([
      fileEntry("readme.md", "/readme.md"),
      dirEntry("src", "/src", [fileEntry("index.ts", "/src/index.ts")]),
    ]);
    const result = await readDroppedItems(dt);
    expect(result.map((r) => r.relativePath).sort()).toEqual([
      "readme.md",
      "src/index.ts",
    ]);
  });

  it("returns relative paths without a leading slash", async () => {
    const dt = dataTransferOf([fileEntry("x", "/x")]);
    const result = await readDroppedItems(dt);
    expect(result[0].relativePath.startsWith("/")).toBe(false);
  });

  it("returns empty when nothing is dropped", async () => {
    const dt = dataTransferOf([]);
    const result = await readDroppedItems(dt);
    expect(result).toEqual([]);
  });

  it("falls back to dataTransfer.files when webkitGetAsEntry is unavailable", async () => {
    const f = new File(["hi"], "legacy.txt");
    const dt = {
      // No items API at all
      items: undefined as unknown as DataTransferItemList,
      files: [f] as unknown as FileList,
    } as DataTransfer;
    const result = await readDroppedItems(dt);
    expect(result.map((r) => r.relativePath)).toEqual(["legacy.txt"]);
    expect(result[0].file).toBe(f);
  });

  it("drains readEntries in batches until empty", async () => {
    // Simulate a directory whose reader returns entries in two batches.
    const children1 = [fileEntry("1", "/d/1"), fileEntry("2", "/d/2")];
    const children2 = [fileEntry("3", "/d/3")];
    let call = 0;
    const dir: MockDirEntry = {
      isFile: false,
      isDirectory: true,
      name: "d",
      fullPath: "/d",
      createReader: () => ({
        readEntries: (cb) => {
          call++;
          if (call === 1) cb(children1);
          else if (call === 2) cb(children2);
          else cb([]);
        },
      }),
    };
    const dt = dataTransferOf([dir]);
    const result = await readDroppedItems(dt);
    expect(result.map((r) => r.relativePath).sort()).toEqual([
      "d/1",
      "d/2",
      "d/3",
    ]);
  });
});
