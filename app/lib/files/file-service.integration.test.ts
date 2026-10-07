import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthContext } from "~/lib/auth/auth.server";
import { AuthorizationService } from "~/lib/auth/authorization-service.server";
import { QuotaService } from "~/lib/auth/quota-service.server";
import { TokenRepository } from "~/lib/auth/token-repository.server";
import { UserRepository } from "~/lib/auth/user-repository.server";
import type { DbClient } from "~/lib/db/client.server";
import { FileNodeRepository } from "~/lib/files/file-node-repository.server";
import { FileService } from "~/lib/files/file-service.server";
import { TrashRepository } from "~/lib/files/trash-repository.server";
import { VersionRepository } from "~/lib/files/version-repository.server";
import { ChunkedStorage } from "~/lib/storage/chunked.server";
import { MemoryStorageAdapter } from "~/lib/storage/memory.server";
import {
  asTestTx,
  FINITE_TEST_LIMITS,
  seedTestUser,
} from "~/test/integration-helpers";
import { createTestDb } from "~/test/test-db";

let tx: ReturnType<typeof asTestTx>;
const USER = "user_fs_test";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Join path segments into a rawPath string for test use. */
function rawPath(segments: string[]): string {
  return segments.join("/");
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function userAuth(): AuthContext {
  return { type: "user", user_id: USER };
}

function tokenAuth(
  accessPaths: {
    path: string;
    access: "read" | "write";
  }[] = [],
): AuthContext {
  return {
    type: "token",
    user_id: USER,
    token_id: "tok1",
    base_path: "/",
    can_delegate: false,
    access_paths: accessPaths,
    resource: null,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: DbClient;
let memStorage: MemoryStorageAdapter;
let storage: ChunkedStorage;
let repo: FileNodeRepository;
let trashRepo: TrashRepository;
let versionRepo: VersionRepository;
let service: FileService;

beforeAll(async () => {
  db = await createTestDb();

  tx = asTestTx(db);
});

beforeEach(async () => {
  await db.execute("DELETE FROM file_nodes");
  await db.execute(`DELETE FROM "user"`);
  await seedTestUser(db, {
    id: USER,
    email: "test@test.com",
    limits: FINITE_TEST_LIMITS,
    bytesUsed: 0,
    createdAt: "2024-01-01",
  });

  memStorage = new MemoryStorageAdapter();
  storage = new ChunkedStorage(memStorage, USER);
  repo = new FileNodeRepository();
  trashRepo = new TrashRepository();
  versionRepo = new VersionRepository();
  const authz = new AuthorizationService();
  const quota = new QuotaService(
    new UserRepository(db),
    new TokenRepository(db),
  );
  service = new FileService(
    db,
    USER,
    storage,
    repo,
    trashRepo,
    versionRepo,
    authz,
    quota,
  );
});

// Helper: put a file via the service
async function seedFile(
  path: string[],
  content: string,
  contentType = "text/plain",
) {
  const result = await service.putFile(
    userAuth(),
    rawPath(path),
    enc.encode(content).buffer as ArrayBuffer,
    contentType,
  );
  if (!result.ok) throw new Error(`seedFile failed: ${result.code}`);
  return result;
}

// Helper: create a directory via repo directly
async function seedDir(path: string[]) {
  return repo.ensureDirectoryPath(USER, path, tx);
}

// ===========================================================================
// Tests
// ===========================================================================

describe("FileService", () => {
  // ---- getFile ------------------------------------------------------------

  describe("getFile", () => {
    it("returns file content", async () => {
      await seedFile(["hello.txt"], "hello world");
      const result = await service.getFile(userAuth(), rawPath(["hello.txt"]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.contentType).toBe("text/plain");
      const text = await new Response(result.body).text();
      expect(text).toBe("hello world");
    });

    it("returns not_found for missing path", async () => {
      const result = await service.getFile(userAuth(), rawPath(["nope.txt"]));
      expect(result).toEqual({ ok: false, code: "not_found" });
    });

    it("returns not_found for directory", async () => {
      await seedDir(["docs"]);
      const result = await service.getFile(userAuth(), rawPath(["docs"]));
      expect(result).toEqual({ ok: false, code: "not_found" });
    });

    it("returns not_found for empty segments (root)", async () => {
      const result = await service.getFile(userAuth(), rawPath([]));
      expect(result).toEqual({ ok: false, code: "not_found" });
    });

    it("returns forbidden for token without read permission", async () => {
      await seedFile(["secret.txt"], "secret");
      const auth = tokenAuth([]);
      const result = await service.getFile(auth, rawPath(["secret.txt"]));
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });

    it("allows token with read on ancestor path", async () => {
      await seedFile(["docs", "file.txt"], "content");
      const auth = tokenAuth([{ path: "docs", access: "read" }]);
      const result = await service.getFile(auth, rawPath(["docs", "file.txt"]));
      expect(result.ok).toBe(true);
    });

    it("returns invalid_path for path traversal", async () => {
      const result = await service.getFile(userAuth(), "../etc/passwd");
      expect(result).toEqual({ ok: false, code: "invalid_path" });
    });

    it("denies token when file is outside permitted path", async () => {
      await seedFile(["docs", "file.txt"], "content");
      await seedFile(["secrets", "key.txt"], "secret");
      const auth = tokenAuth([{ path: "docs", access: "write" }]);
      const allowed = await service.getFile(
        auth,
        rawPath(["docs", "file.txt"]),
      );
      expect(allowed.ok).toBe(true);
      const denied = await service.getFile(
        auth,
        rawPath(["secrets", "key.txt"]),
      );
      expect(denied).toEqual({ ok: false, code: "forbidden" });
    });

    it("returns bodySize equal to size when no range is requested", async () => {
      await seedFile(["bs.txt"], "abcdefghij"); // 10 bytes
      const result = await service.getFile(userAuth(), rawPath(["bs.txt"]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.size).toBe(10);
      expect(result.bodySize).toBe(10);
      expect(result.servedRange).toBeUndefined();
    });
  });

  // ---- getFile with range -------------------------------------------------

  describe("getFile (range)", () => {
    it("returns the requested bounded range with servedRange set", async () => {
      await seedFile(["r.txt"], "0123456789"); // 10 bytes
      const result = await service.getFile(userAuth(), rawPath(["r.txt"]), {
        range: { type: "bounded", firstByte: 2, lastByte: 5 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.size).toBe(10);
      expect(result.bodySize).toBe(4);
      expect(result.servedRange).toEqual({ offset: 2, length: 4 });
      const text = await new Response(result.body).text();
      expect(text).toBe("2345");
    });

    it("clamps a bounded range whose lastByte >= size", async () => {
      await seedFile(["r2.txt"], "0123456789");
      const result = await service.getFile(userAuth(), rawPath(["r2.txt"]), {
        range: { type: "bounded", firstByte: 7, lastByte: 999 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.servedRange).toEqual({ offset: 7, length: 3 });
      const text = await new Response(result.body).text();
      expect(text).toBe("789");
    });

    it("resolves an open-ended range (bytes=N-) to size-1", async () => {
      await seedFile(["r3.txt"], "0123456789");
      const result = await service.getFile(userAuth(), rawPath(["r3.txt"]), {
        range: { type: "from", firstByte: 6 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.servedRange).toEqual({ offset: 6, length: 4 });
      const text = await new Response(result.body).text();
      expect(text).toBe("6789");
    });

    it("resolves a suffix range (bytes=-N)", async () => {
      await seedFile(["r4.txt"], "0123456789");
      const result = await service.getFile(userAuth(), rawPath(["r4.txt"]), {
        range: { type: "suffix", suffixLength: 3 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.servedRange).toEqual({ offset: 7, length: 3 });
      const text = await new Response(result.body).text();
      expect(text).toBe("789");
    });

    it("clamps a suffix range larger than size to the whole file", async () => {
      await seedFile(["r5.txt"], "0123456789");
      const result = await service.getFile(userAuth(), rawPath(["r5.txt"]), {
        range: { type: "suffix", suffixLength: 999 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.servedRange).toEqual({ offset: 0, length: 10 });
      const text = await new Response(result.body).text();
      expect(text).toBe("0123456789");
    });

    it("returns range_not_satisfiable with size and contentVersion when firstByte >= size", async () => {
      await seedFile(["r6.txt"], "0123456789");
      const result = await service.getFile(userAuth(), rawPath(["r6.txt"]), {
        range: { type: "bounded", firstByte: 100, lastByte: 200 },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("range_not_satisfiable");
      if (result.code !== "range_not_satisfiable") return;
      expect(result.size).toBe(10);
      expect(typeof result.contentVersion).toBe("number");
    });

    it("returns range_not_satisfiable for bytes=N- when N >= size", async () => {
      await seedFile(["r7.txt"], "0123456789");
      const result = await service.getFile(userAuth(), rawPath(["r7.txt"]), {
        range: { type: "from", firstByte: 10 },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("range_not_satisfiable");
    });

    it("returns range_not_satisfiable for suffix=0", async () => {
      await seedFile(["r8.txt"], "0123456789");
      const result = await service.getFile(userAuth(), rawPath(["r8.txt"]), {
        range: { type: "suffix", suffixLength: 0 },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("range_not_satisfiable");
    });

    it("returns range_not_satisfiable for any range on a 0-byte file", async () => {
      await seedFile(["r9.txt"], "");
      const result = await service.getFile(userAuth(), rawPath(["r9.txt"]), {
        range: { type: "bounded", firstByte: 0, lastByte: 0 },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("range_not_satisfiable");
    });

    it("falls back to full body when applyRangeIfContentVersion does not match", async () => {
      await seedFile(["r10.txt"], "0123456789");
      const result = await service.getFile(userAuth(), rawPath(["r10.txt"]), {
        range: { type: "bounded", firstByte: 2, lastByte: 5 },
        applyRangeIfContentVersion: 99999, // does not match current version
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.bodySize).toBe(10);
      expect(result.servedRange).toBeUndefined();
      const text = await new Response(result.body).text();
      expect(text).toBe("0123456789");
    });

    it("applies range when applyRangeIfContentVersion matches", async () => {
      await seedFile(["r11.txt"], "0123456789");
      const head = await service.headFile(userAuth(), rawPath(["r11.txt"]));
      expect(head.ok).toBe(true);
      if (!head.ok) return;
      const result = await service.getFile(userAuth(), rawPath(["r11.txt"]), {
        range: { type: "bounded", firstByte: 2, lastByte: 5 },
        applyRangeIfContentVersion: head.contentVersion,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.servedRange).toEqual({ offset: 2, length: 4 });
      const text = await new Response(result.body).text();
      expect(text).toBe("2345");
    });
  });

  // ---- headFile -----------------------------------------------------------

  describe("headFile", () => {
    it("returns size and contentType", async () => {
      await seedFile(["test.txt"], "12345");
      const result = await service.headFile(userAuth(), rawPath(["test.txt"]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.size).toBe(5);
      expect(result.contentType).toBe("text/plain");
    });

    it("returns not_found for missing path", async () => {
      const result = await service.headFile(userAuth(), rawPath(["nope"]));
      expect(result).toEqual({ ok: false, code: "not_found" });
    });

    it("returns not_found for directory", async () => {
      await seedDir(["docs"]);
      const result = await service.headFile(userAuth(), rawPath(["docs"]));
      expect(result).toEqual({ ok: false, code: "not_found" });
    });

    it("returns forbidden for token without read", async () => {
      await seedFile(["file.txt"], "x");
      const result = await service.headFile(
        tokenAuth([]),
        rawPath(["file.txt"]),
      );
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });
  });

  // ---- statPath -----------------------------------------------------------

  describe("statPath", () => {
    it("returns file stat", async () => {
      await seedFile(["doc.pdf"], "pdf content", "application/pdf");
      const result = await service.statPath(userAuth(), rawPath(["doc.pdf"]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.isDirectory).toBe(false);
      expect(result.contentType).toBe("application/pdf");
      expect(result.nodeId).toBeTruthy();
    });

    it("returns directory stat", async () => {
      await seedDir(["docs"]);
      const result = await service.statPath(userAuth(), rawPath(["docs"]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.isDirectory).toBe(true);
    });

    it("returns root stat for empty segments", async () => {
      const result = await service.statPath(userAuth(), rawPath([]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.isDirectory).toBe(true);
      expect(result.nodeId).toBe("");
    });

    it("returns not_found for missing path", async () => {
      const result = await service.statPath(userAuth(), rawPath(["nope"]));
      expect(result).toEqual({ ok: false, code: "not_found" });
    });

    it("returns forbidden for token without read", async () => {
      await seedFile(["x.txt"], "x");
      const result = await service.statPath(tokenAuth([]), rawPath(["x.txt"]));
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });
  });

  // ---- listDirectory ------------------------------------------------------

  describe("listDirectory", () => {
    it("lists root children", async () => {
      await seedFile(["a.txt"], "a");
      await seedFile(["b.txt"], "b");
      const result = await service.listDirectory(userAuth(), rawPath([]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items).toHaveLength(2);
      expect(result.items.map((i) => i.name).sort()).toEqual([
        "a.txt",
        "b.txt",
      ]);
    });

    it("returns hash, revisionId, contentVersion, contentType for files", async () => {
      await seedFile(["meta.txt"], "hello");
      const result = await service.listDirectory(userAuth(), rawPath([]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const item = result.items[0];
      expect(item.name).toBe("meta.txt");
      expect(item.hash).toEqual(expect.any(String));
      expect(item.revisionId).toEqual(expect.any(String));
      expect(item.contentVersion).toBeGreaterThanOrEqual(1);
      expect(item.contentType).toBe("text/plain");
    });

    it("returns null hash/revisionId for directories", async () => {
      await seedDir(["folder"]);
      const result = await service.listDirectory(userAuth(), rawPath([]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const dir = result.items.find((i) => i.name === "folder");
      expect(dir).toBeDefined();
      expect(dir?.hash).toBeNull();
      expect(dir?.revisionId).toBeNull();
      expect(dir?.contentVersion).toBe(0);
    });

    it("lists subdirectory children", async () => {
      await seedFile(["docs", "file.txt"], "content");
      const result = await service.listDirectory(userAuth(), rawPath(["docs"]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe("file.txt");
    });

    it("returns empty array for empty directory", async () => {
      await seedDir(["empty"]);
      const result = await service.listDirectory(
        userAuth(),
        rawPath(["empty"]),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items).toHaveLength(0);
    });

    it("returns not_found for missing directory", async () => {
      const result = await service.listDirectory(userAuth(), rawPath(["nope"]));
      expect(result).toEqual({ ok: false, code: "not_found" });
    });

    it("returns forbidden for token without read on root", async () => {
      const result = await service.listDirectory(tokenAuth([]), rawPath([]));
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });

    it("returns forbidden for token without read on specific dir", async () => {
      await seedDir(["private"]);
      const result = await service.listDirectory(
        tokenAuth([]),
        rawPath(["private"]),
      );
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });
  });

  // ---- putFile ------------------------------------------------------------

  describe("putFile", () => {
    it("creates a new file", async () => {
      const result = await service.putFile(
        userAuth(),
        rawPath(["new.txt"]),
        enc.encode("hello").buffer as ArrayBuffer,
        "text/plain",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.existed).toBe(false);
      expect(result.size).toBe(5);
    });

    it("overwrites existing file", async () => {
      await seedFile(["file.txt"], "old");
      const result = await service.putFile(
        userAuth(),
        rawPath(["file.txt"]),
        enc.encode("new content").buffer as ArrayBuffer,
        "text/plain",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.existed).toBe(true);
    });

    it("returns conflict when ifNotExists is set and file exists", async () => {
      await seedFile(["file.txt"], "old");
      const result = await service.putFile(
        userAuth(),
        rawPath(["file.txt"]),
        enc.encode("new").buffer as ArrayBuffer,
        "text/plain",
        { ifNotExists: true },
      );
      expect(result).toEqual({ ok: false, code: "conflict" });
    });

    it("succeeds when ifNotExists is set and file does not exist", async () => {
      const result = await service.putFile(
        userAuth(),
        rawPath(["fresh.txt"]),
        enc.encode("hi").buffer as ArrayBuffer,
        "text/plain",
        { ifNotExists: true },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.existed).toBe(false);
    });

    it("creates intermediate directories", async () => {
      const result = await service.putFile(
        userAuth(),
        rawPath(["a", "b", "c.txt"]),
        enc.encode("deep").buffer as ArrayBuffer,
        "text/plain",
      );
      expect(result.ok).toBe(true);
      const dirId = await repo.resolvePath(USER, ["a", "b"], tx);
      expect(dirId).toBeTruthy();
    });

    it("returns forbidden for token without write", async () => {
      const auth = tokenAuth([{ path: "", access: "read" }]);
      const result = await service.putFile(
        auth,
        rawPath(["file.txt"]),
        enc.encode("x").buffer as ArrayBuffer,
        "text/plain",
      );
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });

    it("returns quota_exceeded when storage limit exceeded", async () => {
      // Set bytes_used close to limit (1 GB limit)
      await db.execute(
        "UPDATE user_storage SET bytes_used = $1 WHERE user_id = $2",
        [1024 * 1024 * 1024 - 1, USER],
      );
      const bigContent = new Uint8Array(100);
      const result = await service.putFile(
        userAuth(),
        rawPath(["big.bin"]),
        bigContent.buffer as ArrayBuffer,
        "application/octet-stream",
      );
      expect(result).toEqual({ ok: false, code: "quota_exceeded" });
    });

    it("returns invalid_path for path traversal", async () => {
      const result = await service.putFile(
        userAuth(),
        "../etc/passwd",
        enc.encode("x").buffer as ArrayBuffer,
        "text/plain",
      );
      expect(result).toEqual({ ok: false, code: "invalid_path" });
    });

    it("returns invalid_path for root path", async () => {
      const result = await service.putFile(
        userAuth(),
        "/",
        enc.encode("x").buffer as ArrayBuffer,
        "text/plain",
      );
      expect(result).toEqual({ ok: false, code: "invalid_path" });
    });
  });

  // ---- deleteFile ---------------------------------------------------------

  describe("deleteFile", () => {
    it("deletes existing file", async () => {
      await seedFile(["del.txt"], "bye");
      const result = await service.deleteFile(userAuth(), rawPath(["del.txt"]));
      expect(result.ok).toBe(true);

      // Verify it's gone
      const get = await service.getFile(userAuth(), rawPath(["del.txt"]));
      expect(get).toEqual({ ok: false, code: "not_found" });
    });

    it("recursively deletes directory", async () => {
      await seedFile(["dir", "a.txt"], "a");
      await seedFile(["dir", "b.txt"], "b");
      const result = await service.deleteFile(userAuth(), rawPath(["dir"]));
      expect(result.ok).toBe(true);

      const list = await service.listDirectory(userAuth(), rawPath([]));
      expect(list.ok).toBe(true);
      if (list.ok) expect(list.items).toHaveLength(0);
    });

    it("returns invalid_path for root path", async () => {
      const result = await service.deleteFile(userAuth(), "/");
      expect(result).toEqual({ ok: false, code: "invalid_path" });
    });

    it("returns not_found for missing path", async () => {
      const result = await service.deleteFile(userAuth(), rawPath(["nope"]));
      expect(result).toEqual({ ok: false, code: "not_found" });
    });

    it("returns forbidden for token without write", async () => {
      await seedFile(["file.txt"], "x");
      const result = await service.deleteFile(
        tokenAuth([{ path: "", access: "read" }]),
        rawPath(["file.txt"]),
      );
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });
  });

  // ---- moveFile -----------------------------------------------------------

  describe("moveFile", () => {
    it("moves file to new location", async () => {
      await seedFile(["src.txt"], "data");
      const result = await service.moveFile(
        userAuth(),
        rawPath(["src.txt"]),
        rawPath(["dst.txt"]),
      );
      expect(result.ok).toBe(true);

      // Source gone, dest exists
      const src = await service.getFile(userAuth(), rawPath(["src.txt"]));
      expect(src.ok).toBe(false);
      const dst = await service.getFile(userAuth(), rawPath(["dst.txt"]));
      expect(dst.ok).toBe(true);
    });

    it("renames file (same parent)", async () => {
      await seedFile(["old.txt"], "data");
      const result = await service.moveFile(
        userAuth(),
        rawPath(["old.txt"]),
        rawPath(["new.txt"]),
      );
      expect(result.ok).toBe(true);
    });

    it("returns invalid_dest_path for root destination", async () => {
      await seedFile(["src.txt"], "data");
      const result = await service.moveFile(
        userAuth(),
        rawPath(["src.txt"]),
        "/",
      );
      expect(result).toEqual({ ok: false, code: "invalid_dest_path" });
    });

    it("returns not_found when source missing", async () => {
      const result = await service.moveFile(
        userAuth(),
        rawPath(["nope"]),
        rawPath(["dst"]),
      );
      expect(result).toEqual({ ok: false, code: "not_found" });
    });

    it("returns forbidden when token lacks write on source", async () => {
      await seedFile(["file.txt"], "data");
      const auth = tokenAuth([{ path: "", access: "read" }]);
      const result = await service.moveFile(
        auth,
        rawPath(["file.txt"]),
        rawPath(["moved.txt"]),
      );
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });

    it("returns conflict when dest exists", async () => {
      await seedFile(["a.txt"], "a");
      await seedFile(["b.txt"], "b");
      const result = await service.moveFile(
        userAuth(),
        rawPath(["a.txt"]),
        rawPath(["b.txt"]),
      );
      expect(result).toEqual({ ok: false, code: "conflict" });
    });

    it("creates intermediate directories for destination", async () => {
      await seedFile(["file.txt"], "data");
      const result = await service.moveFile(
        userAuth(),
        rawPath(["file.txt"]),
        rawPath(["deep", "nested", "file.txt"]),
      );
      expect(result.ok).toBe(true);

      const dirId = await repo.resolvePath(USER, ["deep", "nested"], tx);
      expect(dirId).toBeTruthy();
    });

    it("returns cycle when moving dir into own subtree", async () => {
      await seedDir(["parent"]);
      await seedDir(["parent", "child"]);
      const result = await service.moveFile(
        userAuth(),
        rawPath(["parent"]),
        rawPath(["parent", "child", "parent"]),
      );
      expect(result).toEqual({ ok: false, code: "cycle" });
    });
  });

  // ---- replaceFile --------------------------------------------------------

  describe("replaceFile", () => {
    it("replaces dest content with src, preserving dest identity", async () => {
      await seedFile(["src.txt"], "new content");
      await seedFile(["dst.txt"], "old content");

      // Get dst node id before replace
      const dstIdBefore = await repo.resolvePath(USER, ["dst.txt"], tx);

      const result = await service.replaceFile(
        userAuth(),
        rawPath(["src.txt"]),
        rawPath(["dst.txt"]),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.nodeId).toBe(dstIdBefore);

      // dst has new content
      const content = await service.getFile(userAuth(), rawPath(["dst.txt"]));
      expect(content.ok).toBe(true);
      if (content.ok) {
        const text = await new Response(content.body).text();
        expect(text).toBe("new content");
      }

      // src is gone (soft-deleted)
      const src = await service.getFile(userAuth(), rawPath(["src.txt"]));
      expect(src.ok).toBe(false);
    });

    it("returns invalid_source_path for root source", async () => {
      await seedFile(["dst.txt"], "data");
      const result = await service.replaceFile(
        userAuth(),
        "/",
        rawPath(["dst.txt"]),
      );
      expect(result).toEqual({ ok: false, code: "invalid_source_path" });
    });

    it("returns invalid_dest_path for root destination", async () => {
      await seedFile(["src.txt"], "data");
      const result = await service.replaceFile(
        userAuth(),
        rawPath(["src.txt"]),
        "/",
      );
      expect(result).toEqual({ ok: false, code: "invalid_dest_path" });
    });

    it("returns not_found when src missing", async () => {
      await seedFile(["dst.txt"], "data");
      const result = await service.replaceFile(
        userAuth(),
        rawPath(["nope"]),
        rawPath(["dst.txt"]),
      );
      expect(result).toEqual({ ok: false, code: "not_found" });
    });

    it("returns not_found when dst missing", async () => {
      await seedFile(["src.txt"], "data");
      const result = await service.replaceFile(
        userAuth(),
        rawPath(["src.txt"]),
        rawPath(["nope"]),
      );
      expect(result).toEqual({ ok: false, code: "not_found" });
    });

    it("returns type_mismatch when src is directory", async () => {
      await seedDir(["srcdir"]);
      await seedFile(["dst.txt"], "data");
      const result = await service.replaceFile(
        userAuth(),
        rawPath(["srcdir"]),
        rawPath(["dst.txt"]),
      );
      expect(result).toEqual({ ok: false, code: "type_mismatch" });
    });

    it("returns type_mismatch when dst is directory", async () => {
      await seedFile(["src.txt"], "data");
      await seedDir(["dstdir"]);
      const result = await service.replaceFile(
        userAuth(),
        rawPath(["src.txt"]),
        rawPath(["dstdir"]),
      );
      expect(result).toEqual({ ok: false, code: "type_mismatch" });
    });

    it("returns forbidden when token lacks write", async () => {
      await seedFile(["src.txt"], "data");
      await seedFile(["dst.txt"], "data");
      const auth = tokenAuth([{ path: "", access: "read" }]);
      const result = await service.replaceFile(
        auth,
        rawPath(["src.txt"]),
        rawPath(["dst.txt"]),
      );
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });
  });

  // ---- mkdir --------------------------------------------------------------

  describe("mkdir", () => {
    it("creates directory", async () => {
      const result = await service.mkdir(userAuth(), rawPath(["newdir"]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.nodeId).toBeTruthy();
    });

    it("returns invalid_path for root path", async () => {
      const result = await service.mkdir(userAuth(), "/");
      expect(result).toEqual({ ok: false, code: "invalid_path" });
    });

    it("returns conflict when path already exists", async () => {
      await seedDir(["existing"]);
      const result = await service.mkdir(userAuth(), rawPath(["existing"]));
      expect(result).toEqual({ ok: false, code: "conflict" });
    });

    it("returns forbidden for token without write", async () => {
      const auth = tokenAuth([{ path: "", access: "read" }]);
      const result = await service.mkdir(auth, rawPath(["newdir"]));
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });

    it("creates intermediate directories", async () => {
      const result = await service.mkdir(userAuth(), rawPath(["a", "b", "c"]));
      expect(result.ok).toBe(true);
      const id = await repo.resolvePath(USER, ["a", "b"], tx);
      expect(id).toBeTruthy();
    });
  });

  // ---- copyFile -----------------------------------------------------------

  describe("copyFile", () => {
    it("copies file to new location", async () => {
      await seedFile(["original.txt"], "content");
      const result = await service.copyFile(
        userAuth(),
        rawPath(["original.txt"]),
        rawPath(["copy.txt"]),
        false,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.existed).toBe(false);

      // Both files should exist with same content
      const orig = await service.getFile(userAuth(), rawPath(["original.txt"]));
      const copy = await service.getFile(userAuth(), rawPath(["copy.txt"]));
      expect(orig.ok).toBe(true);
      expect(copy.ok).toBe(true);
    });

    it("returns invalid_source_path for root source", async () => {
      const result = await service.copyFile(
        userAuth(),
        "/",
        rawPath(["dst"]),
        false,
      );
      expect(result).toEqual({ ok: false, code: "invalid_source_path" });
    });

    it("returns invalid_dest_path for root destination", async () => {
      await seedFile(["src.txt"], "data");
      const result = await service.copyFile(
        userAuth(),
        rawPath(["src.txt"]),
        "/",
        false,
      );
      expect(result).toEqual({ ok: false, code: "invalid_dest_path" });
    });

    it("returns not_found for missing source", async () => {
      const result = await service.copyFile(
        userAuth(),
        rawPath(["nope"]),
        rawPath(["copy"]),
        false,
      );
      expect(result).toEqual({ ok: false, code: "not_found" });
    });

    it("returns forbidden for token without read on source", async () => {
      await seedFile(["file.txt"], "x");
      const result = await service.copyFile(
        tokenAuth([]),
        rawPath(["file.txt"]),
        rawPath(["copy.txt"]),
        false,
      );
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });

    it("returns conflict when dest exists and overwrite=false", async () => {
      await seedFile(["a.txt"], "a");
      await seedFile(["b.txt"], "b");
      const result = await service.copyFile(
        userAuth(),
        rawPath(["a.txt"]),
        rawPath(["b.txt"]),
        false,
      );
      expect(result).toEqual({ ok: false, code: "conflict" });
    });

    it("returns not_implemented for directory copy (single-file primitive)", async () => {
      // copyFile remains file-only; directory copy goes through
      // copyTree (asserted in the dedicated describe block below).
      await seedDir(["mydir"]);
      const result = await service.copyFile(
        userAuth(),
        rawPath(["mydir"]),
        rawPath(["mydir-copy"]),
        false,
      );
      expect(result).toEqual({ ok: false, code: "not_implemented" });
    });
  });

  // ---- copyTree (directory copy) ---------------------------------

  describe("copyTree", () => {
    it("recursively copies a directory subtree", async () => {
      await seedDir(["src"]);
      await seedDir(["src", "nested"]);
      await seedFile(["src", "a.txt"], "aaa");
      await seedFile(["src", "nested", "b.txt"], "bbb");

      const result = await service.copyTree(
        userAuth(),
        rawPath(["src"]),
        rawPath(["dst"]),
        false,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Destination tree mirrors the source.
      const aGet = await service.getFile(userAuth(), rawPath(["dst", "a.txt"]));
      expect(aGet.ok).toBe(true);
      const bGet = await service.getFile(
        userAuth(),
        rawPath(["dst", "nested", "b.txt"]),
      );
      expect(bGet.ok).toBe(true);

      // Entries list contains every node we touched.
      const destPaths = result.entries.map((e) => e.destPath).sort();
      expect(destPaths).toEqual(
        ["/dst", "/dst/a.txt", "/dst/nested", "/dst/nested/b.txt"].sort(),
      );
    });

    it("history-preserving overwrite: existing dest file keeps node id, new revision appended", async () => {
      await seedDir(["src"]);
      await seedFile(["src", "f.txt"], "new-bytes");
      await seedDir(["dst"]);
      await seedFile(["dst", "f.txt"], "old-bytes");

      const destNodeIdBefore = await repo.resolvePath(
        USER,
        ["dst", "f.txt"],
        tx,
      );
      expect(destNodeIdBefore).toBeTruthy();

      const result = await service.copyTree(
        userAuth(),
        rawPath(["src"]),
        rawPath(["dst"]),
        true,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Same node id at destination — node identity preserved.
      const destNodeIdAfter = await repo.resolvePath(
        USER,
        ["dst", "f.txt"],
        tx,
      );
      expect(destNodeIdAfter).toBe(destNodeIdBefore);

      // A revision was added; the file now has 2 revisions on the same node.
      if (!destNodeIdAfter) throw new Error("dest node missing");
      const revs = await versionRepo.listRevisions(destNodeIdAfter, tx);
      expect(revs.length).toBeGreaterThanOrEqual(2);

      // Current bytes are the source bytes.
      const got = await service.getFile(userAuth(), rawPath(["dst", "f.txt"]));
      expect(got.ok).toBe(true);
      if (got.ok) {
        const body = await new Response(got.body).text();
        expect(body).toBe("new-bytes");
      }
    });

    it("partial failure: returns ok:false with entries written so far", async () => {
      // Seed src with two siblings. Pre-create dst/b.txt as a directory so
      // copying the file src/b.txt hits a type_mismatch mid-walk.
      await seedDir(["src"]);
      await seedFile(["src", "a.txt"], "a");
      await seedFile(["src", "b.txt"], "b");
      await seedDir(["dst"]);
      await seedDir(["dst", "b.txt"]);

      const result = await service.copyTree(
        userAuth(),
        rawPath(["src"]),
        rawPath(["dst"]),
        true,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Non-atomic by contract: a.txt should have been written before the
      // failure on b.txt.
      const destPaths = result.entries.map((e) => e.destPath);
      expect(destPaths).toContain("/dst/a.txt");

      const aGet = await service.getFile(userAuth(), rawPath(["dst", "a.txt"]));
      expect(aGet.ok).toBe(true);

      // Server is consistent: the pre-existing dst/b.txt directory is
      // untouched (no orphan revision/node created from the half-completed
      // file write).
      const stat = await service.statPath(
        userAuth(),
        rawPath(["dst", "b.txt"]),
      );
      expect(stat.ok).toBe(true);
      if (stat.ok) expect(stat.isDirectory).toBe(true);
    });

    it("rejects file source (must dispatch to copyFile)", async () => {
      await seedFile(["only.txt"], "hello");
      const result = await service.copyTree(
        userAuth(),
        rawPath(["only.txt"]),
        rawPath(["copy.txt"]),
        false,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("type_mismatch");
    });

    it("rejects copying a directory into its own subtree (cycle)", async () => {
      await seedDir(["outer"]);
      await seedDir(["outer", "inner"]);
      const result = await service.copyTree(
        userAuth(),
        rawPath(["outer"]),
        rawPath(["outer", "inner", "outer"]),
        false,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("cycle");
    });

    it("conflict when dst exists as directory and overwrite=false", async () => {
      await seedDir(["src"]);
      await seedFile(["src", "a.txt"], "a");
      await seedDir(["dst"]);

      const result = await service.copyTree(
        userAuth(),
        rawPath(["src"]),
        rawPath(["dst"]),
        false,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("conflict");
    });

    it("type_mismatch when dst exists as file", async () => {
      await seedDir(["src"]);
      await seedFile(["src", "a.txt"], "a");
      await seedFile(["dst"], "file-not-dir");

      const result = await service.copyTree(
        userAuth(),
        rawPath(["src"]),
        rawPath(["dst"]),
        true,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("type_mismatch");
    });
  });

  // ---- deleteVersion --------------------------------------------

  describe("deleteVersion", () => {
    it("deletes a non-current revision and decrements bytes_used", async () => {
      // Create file, then overwrite to get 2 revisions
      await seedFile(["ver.txt"], "v1");
      await seedFile(["ver.txt"], "v2-longer");

      const nodeId = await repo.resolvePath(USER, ["ver.txt"], tx);
      if (!nodeId) throw new Error("node not found");
      const revisions = await versionRepo.listRevisions(nodeId, tx);
      expect(revisions).toHaveLength(2);

      const node = await repo.getNode(USER, nodeId, tx);
      if (!node) throw new Error("node not found");
      const nonCurrentRev = revisions.find(
        (r) => r.id !== node.currentRevisionId,
      );
      if (!nonCurrentRev) throw new Error("non-current revision not found");
      const nonCurrentSize = nonCurrentRev.size;

      const beforeUsed = await getBytesUsed();

      const result = await service.deleteVersion(userAuth(), nonCurrentRev.id);
      expect(result.ok).toBe(true);

      // Verify revision is deleted
      const afterRevisions = await versionRepo.listRevisions(nodeId, tx);
      expect(afterRevisions).toHaveLength(1);

      // Verify bytes_used decreased
      const afterUsed = await getBytesUsed();
      expect(afterUsed).toBe(beforeUsed - nonCurrentSize);
    });

    it("returns is_current when trying to delete current revision", async () => {
      await seedFile(["file.txt"], "content");
      const nodeId = await repo.resolvePath(USER, ["file.txt"], tx);
      if (!nodeId) throw new Error("node not found");
      const node = await repo.getNode(USER, nodeId, tx);
      if (!node?.currentRevisionId)
        throw new Error("node or revision not found");

      const result = await service.deleteVersion(
        userAuth(),
        node.currentRevisionId,
      );
      expect(result).toEqual({ ok: false, code: "is_current" });
    });

    it("returns not_found for non-existent revision", async () => {
      const result = await service.deleteVersion(userAuth(), "nonexistent-id");
      expect(result).toEqual({ ok: false, code: "not_found" });
    });

    it("returns forbidden for token without write on file path", async () => {
      await seedFile(["secret", "file.txt"], "v1");
      await seedFile(["secret", "file.txt"], "v2");

      const nodeId = await repo.resolvePath(USER, ["secret", "file.txt"], tx);
      if (!nodeId) throw new Error("node not found");
      const node = await repo.getNode(USER, nodeId, tx);
      if (!node) throw new Error("node not found");
      const revisions = await versionRepo.listRevisions(nodeId, tx);
      const nonCurrent = revisions.find((r) => r.id !== node.currentRevisionId);
      if (!nonCurrent) throw new Error("non-current revision not found");

      const auth = tokenAuth([{ path: "public", access: "write" }]);
      const result = await service.deleteVersion(auth, nonCurrent.id);
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });

    it("allows deleting a revision of a trashed file", async () => {
      // Create file with 2 revisions, then soft-delete it
      await seedFile(["trashed.txt"], "v1");
      await seedFile(["trashed.txt"], "v2");
      const nodeId = await repo.resolvePath(USER, ["trashed.txt"], tx);
      if (!nodeId) throw new Error("node not found");
      await service.deleteFile(userAuth(), rawPath(["trashed.txt"]));

      // Get revisions (file is now in trash)
      const revisions = await versionRepo.listRevisions(nodeId, tx);
      expect(revisions).toHaveLength(2);

      // Find non-current revision
      const trashNode = await trashRepo.getTrashNode(USER, nodeId, tx);
      if (!trashNode) throw new Error("trash node not found");
      const nonCurrent = revisions.find(
        (r) => r.id !== trashNode.currentRevisionId,
      );
      if (!nonCurrent) throw new Error("non-current revision not found");

      const result = await service.deleteVersion(userAuth(), nonCurrent.id);
      expect(result.ok).toBe(true);

      const afterRevisions = await versionRepo.listRevisions(nodeId, tx);
      expect(afterRevisions).toHaveLength(1);
    });
  });

  // ---- purgeTrashItem -------------------------------------------

  describe("purgeTrashItem", () => {
    it("permanently deletes a trashed file and decrements bytes_used", async () => {
      await seedFile(["purge-me.txt"], "content");
      const nodeId = await repo.resolvePath(USER, ["purge-me.txt"], tx);
      if (!nodeId) throw new Error("node not found");
      await service.deleteFile(userAuth(), rawPath(["purge-me.txt"]));

      const beforeUsed = await getBytesUsed();
      expect(beforeUsed).toBeGreaterThan(0);

      const result = await service.purgeTrashItem(userAuth(), nodeId);
      expect(result.ok).toBe(true);

      // Node is completely gone
      const trashNode = await trashRepo.getTrashNode(USER, nodeId, tx);
      expect(trashNode).toBeNull();

      // bytes_used decreased
      const afterUsed = await getBytesUsed();
      expect(afterUsed).toBe(0);
    });

    it("purges a directory and all descendants", async () => {
      await seedFile(["dir", "a.txt"], "aaa");
      await seedFile(["dir", "b.txt"], "bbb");
      await service.deleteFile(userAuth(), rawPath(["dir"]));

      // Get dir node id from trash
      const trashItems = await trashRepo.listTrash(USER, tx);
      const dirItem = trashItems.find((n) => n.name === "dir");
      if (!dirItem) throw new Error("dir not found in trash");

      const result = await service.purgeTrashItem(userAuth(), dirItem.id);
      expect(result.ok).toBe(true);

      // All nodes gone
      const afterTrash = await trashRepo.listTrash(USER, tx);
      expect(afterTrash).toHaveLength(0);

      // bytes_used is 0
      const used = await getBytesUsed();
      expect(used).toBe(0);
    });

    it("returns not_found for a live (non-trashed) node", async () => {
      await seedFile(["live.txt"], "data");
      const nodeId = await repo.resolvePath(USER, ["live.txt"], tx);
      if (!nodeId) throw new Error("node not found");

      const result = await service.purgeTrashItem(userAuth(), nodeId);
      expect(result).toEqual({ ok: false, code: "not_found" });
    });

    it("returns not_found for non-existent node", async () => {
      const result = await service.purgeTrashItem(userAuth(), "nonexistent-id");
      expect(result).toEqual({ ok: false, code: "not_found" });
    });
  });

  // ---- purgeAllTrash --------------------------------------------

  describe("purgeAllTrash", () => {
    it("permanently deletes all trashed items", async () => {
      await seedFile(["a.txt"], "aaa");
      await seedFile(["b.txt"], "bbb");
      await service.deleteFile(userAuth(), rawPath(["a.txt"]));
      await service.deleteFile(userAuth(), rawPath(["b.txt"]));

      const trashBefore = await trashRepo.listTrash(USER, tx);
      expect(trashBefore).toHaveLength(2);

      const result = await service.purgeAllTrash(userAuth());
      expect(result.ok).toBe(true);

      // All trash gone
      const trashAfter = await trashRepo.listTrash(USER, tx);
      expect(trashAfter).toHaveLength(0);

      // bytes_used is 0
      const used = await getBytesUsed();
      expect(used).toBe(0);
    });

    it("succeeds on empty trash (no-op)", async () => {
      const result = await service.purgeAllTrash(userAuth());
      expect(result.ok).toBe(true);
    });

    // Purge is audit-only — no per-node assertions remain.
    // Aggregate observability is via logInfo; we verify the operation
    // itself (DB delete + quota) elsewhere in the suite.
  });

  // ---- restoreRevision contract ---------------------------------
  // Client #5: version restore is best-effort. A revision the UI displayed
  // may have been pruned / over-quota-deleted / explicitly version-deleted
  // before the restore click landed. We surface that distinctly from a true
  // concurrent-edit conflict so the UI can show a useful message.
  describe("restoreRevision", () => {
    it("returns revision_gone when the chosen revision was deleted before restore", async () => {
      // Seed v1 then v2 to build a 2-revision history.
      await seedFile(["versioned.txt"], "v1");
      const listBefore = await service.listRevisions(
        userAuth(),
        rawPath(["versioned.txt"]),
      );
      if (!listBefore.ok) throw new Error("listRevisions failed");
      const v1Id = listBefore.revisions[0].id;
      await seedFile(["versioned.txt"], "v2");

      // Race: v1 is pruned out from under the UI before the restore click.
      const del = await service.deleteVersion(userAuth(), v1Id);
      expect(del.ok).toBe(true);

      const result = await service.restoreRevision(
        userAuth(),
        rawPath(["versioned.txt"]),
        v1Id,
      );
      expect(result).toEqual({ ok: false, code: "revision_gone" });
    });
  });

  // ---- file-scope token coverage --------------------------------
  // A token whose access_path is narrowed to a single file must be able to run
  // every write operation on that target path. Also verifies that an adjacent
  // path (`/TASK.md.bak`) is rejected at the prefix-match boundary.
  describe("file-scope token", () => {
    function fileScope(path: string) {
      return tokenAuth([{ path, access: "write" }]);
    }

    it("putFile: creates file at scoped path", async () => {
      const result = await service.putFile(
        fileScope("/TASK.md"),
        rawPath(["TASK.md"]),
        enc.encode("hi").buffer as ArrayBuffer,
        "text/markdown",
      );
      expect(result.ok).toBe(true);
    });

    it("putFile: overwrites existing file at scoped path", async () => {
      await seedFile(["TASK.md"], "old");
      const result = await service.putFile(
        fileScope("/TASK.md"),
        rawPath(["TASK.md"]),
        enc.encode("new").buffer as ArrayBuffer,
        "text/markdown",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.existed).toBe(true);
    });

    it("putFile: rejects adjacent path outside scope (boundary)", async () => {
      const result = await service.putFile(
        fileScope("/TASK.md"),
        rawPath(["TASK.md.bak"]),
        enc.encode("x").buffer as ArrayBuffer,
        "text/plain",
      );
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });

    it("deleteFile: deletes file at scoped path", async () => {
      await seedFile(["TASK.md"], "x");
      const result = await service.deleteFile(
        fileScope("/TASK.md"),
        rawPath(["TASK.md"]),
      );
      expect(result.ok).toBe(true);
    });

    it("replaceFile: src + dest both at scoped paths", async () => {
      await seedFile(["A.md"], "a");
      await seedFile(["B.md"], "b");
      const auth = tokenAuth([
        { path: "A.md", access: "write" },
        { path: "B.md", access: "write" },
      ]);
      const result = await service.replaceFile(
        auth,
        rawPath(["A.md"]),
        rawPath(["B.md"]),
      );
      expect(result.ok).toBe(true);
    });

    it("mkdir: creates directory at scoped path", async () => {
      const result = await service.mkdir(
        fileScope("/scoped-dir"),
        rawPath(["scoped-dir"]),
      );
      expect(result.ok).toBe(true);
    });

    it("mkdir: rejects adjacent path outside scope (boundary)", async () => {
      const result = await service.mkdir(
        fileScope("/scoped-dir"),
        rawPath(["other-dir"]),
      );
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });

    it("moveFile: src + dest both at scoped paths", async () => {
      await seedFile(["from.md"], "x");
      const auth = tokenAuth([
        { path: "from.md", access: "write" },
        { path: "to.md", access: "write" },
      ]);
      const result = await service.moveFile(
        auth,
        rawPath(["from.md"]),
        rawPath(["to.md"]),
      );
      expect(result.ok).toBe(true);
    });

    it("moveFile: rejects when dest is outside scope (boundary)", async () => {
      await seedFile(["from.md"], "x");
      const auth = tokenAuth([
        { path: "from.md", access: "write" },
        { path: "to.md", access: "write" },
      ]);
      const result = await service.moveFile(
        auth,
        rawPath(["from.md"]),
        rawPath(["to.md.bak"]),
      );
      expect(result).toEqual({ ok: false, code: "forbidden" });
    });

    it("copyFile: src + dest both at scoped paths", async () => {
      await seedFile(["from.md"], "x");
      const auth = tokenAuth([
        { path: "from.md", access: "write" },
        { path: "to.md", access: "write" },
      ]);
      const result = await service.copyFile(
        auth,
        rawPath(["from.md"]),
        rawPath(["to.md"]),
        false,
      );
      expect(result.ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getBytesUsed(): Promise<number> {
  const row = await db.queryOne<{ bytes_used: number }>(
    "SELECT bytes_used FROM user_storage WHERE user_id = $1",
    [USER],
  );
  return Number(row?.bytes_used ?? 0);
}
