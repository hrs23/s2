import { createDbClient, type DbClient } from "./client.server";

type RuntimeEnv = Env & {
  __testDbClient?: DbClient;
};

function getDatabaseUrl(env: Env): string {
  const runtimeEnv = env as Env & { DATABASE_URL?: string };
  if (runtimeEnv.DATABASE_URL) return runtimeEnv.DATABASE_URL;
  throw new Error("DATABASE_URL is required");
}

const clients = new WeakMap<Env, DbClient>();

export function createDbFromRuntimeEnv(env: Env): DbClient {
  const runtimeEnv = env as RuntimeEnv;
  if (runtimeEnv.__testDbClient) return runtimeEnv.__testDbClient;
  let client = clients.get(env);
  if (!client) {
    client = createDbClient(getDatabaseUrl(env));
    clients.set(env, client);
  }
  return client;
}
