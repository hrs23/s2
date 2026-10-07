import { describe, expect, it } from "vitest";
import { createDbFromRuntimeEnv } from "./runtime.server";

describe("createDbFromRuntimeEnv", () => {
  it("returns one client per env object", () => {
    const env = {
      DATABASE_URL: "postgres://u:p@127.0.0.1:1/db",
    } as unknown as Env;
    expect(createDbFromRuntimeEnv(env)).toBe(createDbFromRuntimeEnv(env));
  });

  it("does not share clients across env objects", () => {
    const a = { DATABASE_URL: "postgres://u:p@127.0.0.1:1/a" } as Env;
    const b = { DATABASE_URL: "postgres://u:p@127.0.0.1:1/b" } as Env;
    expect(createDbFromRuntimeEnv(a)).not.toBe(createDbFromRuntimeEnv(b));
  });
});
