import { vi } from "vitest";
import { getUser } from "~/lib/auth/auth.server";
import { MemoryStorageAdapter } from "~/lib/storage/memory.server";
import { loader } from "../_dashboard";

vi.mock("~/lib/auth/auth.server", () => ({ getUser: vi.fn() }));

const mockedGetUser = vi.mocked(getUser);

function loaderArgs(storage: MemoryStorageAdapter) {
  return {
    request: new Request("http://localhost/files"),
    context: {
      appContext: {
        db: {} as never,
        storage,
        config: {},
      },
      runtime: {
        env: { APP_URL: "http://localhost" } as Env,
      },
    },
    params: {},
  } as never;
}

describe("dashboard storage availability loader", () => {
  it("keeps filesystem availability separate from unlimited logical usage", async () => {
    const storage = new MemoryStorageAdapter();
    vi.spyOn(storage, "availableBytes").mockResolvedValue(3000);
    mockedGetUser.mockResolvedValue({
      email: "owner@example.com",
      storage_limit_bytes: 0,
      bytes_used: 1200,
    } as never);

    await expect(loader(loaderArgs(storage))).resolves.toMatchObject({
      user: { bytes_used: 1200 },
      storageLimit: 0,
      storageAvailableBytes: 3000,
    });
  });

  it("does not query backend capacity for finite storage limits", async () => {
    const storage = new MemoryStorageAdapter();
    const availableBytes = vi.spyOn(storage, "availableBytes");
    mockedGetUser.mockResolvedValue({
      email: "owner@example.com",
      storage_limit_bytes: 250 * 1024 * 1024,
      bytes_used: 1200,
    } as never);

    await expect(loader(loaderArgs(storage))).resolves.toMatchObject({
      storageAvailableBytes: null,
    });
    expect(availableBytes).not.toHaveBeenCalled();
  });

  it("falls back to logical usage only when capacity lookup fails", async () => {
    const storage = new MemoryStorageAdapter();
    vi.spyOn(storage, "availableBytes").mockRejectedValue(
      new Error("unavailable"),
    );
    mockedGetUser.mockResolvedValue({
      email: "owner@example.com",
      storage_limit_bytes: 0,
      bytes_used: 1200,
    } as never);

    await expect(loader(loaderArgs(storage))).resolves.toMatchObject({
      storageAvailableBytes: null,
    });
  });
});
