import path from "node:path";
import type { DbClient } from "~/lib/db/client.server";
import { createDbFromRuntimeEnv } from "~/lib/db/runtime.server";
import type { StorageAdapter } from "~/lib/storage/adapter";
import { FileSystemStorageAdapter } from "~/lib/storage/filesystem.server";

export interface AppContext {
  readonly db: DbClient;
  readonly storage: StorageAdapter;
  readonly config: {
    readonly allowedResources?: string;
  };
}

type RuntimeEnv = Env & {
  __storageAdapter?: StorageAdapter;
  __storageRoot?: string;
};

export function createAppContext(env: Env): AppContext {
  const runtimeEnv = env as RuntimeEnv;
  let storage = runtimeEnv.__storageAdapter;
  if (!storage) {
    if (!runtimeEnv.__storageRoot) {
      throw new Error("__storageRoot or __storageAdapter is required");
    }
    storage = new FileSystemStorageAdapter(
      path.resolve(runtimeEnv.__storageRoot),
    );
  }

  return {
    db: createDbFromRuntimeEnv(env),
    storage,
    config: {
      allowedResources:
        env.ALLOWED_RESOURCES ?? `${env.APP_URL.replace(/\/+$/, "")}/mcp`,
    },
  };
}
