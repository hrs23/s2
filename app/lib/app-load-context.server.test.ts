import type { AppContext } from "~/lib/app-context.server";
import { getAppContext, getRuntimeEnv } from "~/lib/app-load-context.server";
import type { DbClient } from "~/lib/db/client.server";
import { MemoryStorageAdapter } from "~/lib/storage/memory.server";

function makeAppContext(): AppContext {
  return {
    db: { ping: async () => {} } as DbClient,
    storage: new MemoryStorageAdapter(),
    config: {},
  };
}

test("getAppContext returns a runtime-provided AppContext without runtime env", () => {
  const appContext = makeAppContext();

  expect(getAppContext({ appContext })).toBe(appContext);
});

test("getAppContext fails when the load context has no AppContext", () => {
  expect(() => getAppContext({})).toThrow(
    "AppContext missing from AppLoadContext",
  );
});

test("getRuntimeEnv returns the runtime env", () => {
  const env = {} as Env;

  expect(getRuntimeEnv({ runtime: { env } })).toBe(env);
});

test("getRuntimeEnv fails when the load context has no runtime env", () => {
  expect(() => getRuntimeEnv({ appContext: makeAppContext() })).toThrow(
    "Runtime env missing from AppLoadContext",
  );
});
