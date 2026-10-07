import { describe, expect, it } from "vitest";
import { createAppContext } from "~/lib/app-context.server";
import type { DbClient } from "~/lib/db/client.server";
import { MemoryStorageAdapter } from "~/lib/storage/memory.server";

describe("createAppContext config", () => {
  it("defaults allowedResources to the APP_URL /mcp resource when ALLOWED_RESOURCES is unset", () => {
    const env = {
      __testDbClient: { ping: async () => {} } as DbClient,
      __storageAdapter: new MemoryStorageAdapter(),
      APP_URL: "http://localhost:8888",
      AUTH_STORAGE: {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
      },
      AUTH_SECRET: "secret",
    } as unknown as Env;

    expect(createAppContext(env).config.allowedResources).toBe(
      "http://localhost:8888/mcp",
    );
  });

  it("uses ALLOWED_RESOURCES when set", () => {
    const env = {
      __testDbClient: { ping: async () => {} } as DbClient,
      __storageAdapter: new MemoryStorageAdapter(),
      APP_URL: "http://localhost:8888",
      ALLOWED_RESOURCES: "https://example.com/mcp",
      AUTH_STORAGE: {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
      },
      AUTH_SECRET: "secret",
    } as unknown as Env;

    expect(createAppContext(env).config.allowedResources).toBe(
      "https://example.com/mcp",
    );
  });
});
