import { loadDevVars } from "~/lib/dev-vars.server";
import { readSelfHostConfig, type SelfHostConfig } from "./config.server";

const DEFAULT_DEV_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/s2?sslmode=disable";

/** Dev-server config: `.dev.vars` + local Postgres/filesystem defaults. */
export function readDevSelfHostConfig(): SelfHostConfig {
  loadDevVars();
  return readSelfHostConfig({
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? DEFAULT_DEV_DATABASE_URL,
    APP_URL: process.env.APP_URL ?? "http://localhost:8888",
    PORT: process.env.PORT ?? "8888",
    S2_STORAGE_ROOT: process.env.S2_STORAGE_ROOT ?? ".dev/storage",
  });
}
