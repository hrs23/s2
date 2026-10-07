import pg from "pg";
import type { AppContext } from "~/lib/app-context.server";
import { createAppContext } from "~/lib/app-context.server";
import { logError } from "~/lib/observability/logger.server";
import type { SelfHostConfig } from "./config.server";
import { createMemorySecondaryStorage } from "./memory-secondary-storage.server";

export interface SelfHostRuntime {
  readonly appContext: AppContext;
  readonly env: Env;
}

export function createSelfHostRuntime(config: SelfHostConfig): SelfHostRuntime {
  const authPool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 5,
  });
  authPool.on("error", (error) => {
    logError("selfhost.auth_pool", "idle_client_error", {}, error);
  });
  const env = createSelfHostEnv(config, authPool);
  return {
    appContext: createAppContext(env),
    env,
  };
}

export function createSelfHostLoadContext(runtime: SelfHostRuntime) {
  return {
    appContext: runtime.appContext,
    runtime: { env: runtime.env },
  };
}

function createSelfHostEnv(config: SelfHostConfig, authPool: pg.Pool): Env {
  return {
    APP_URL: config.appUrl,
    AUTH_STORAGE: createMemorySecondaryStorage(),
    AUTH_SECRET: config.authSecret,
    DATABASE_URL: config.databaseUrl,
    SIGNUP_ENABLED: String(config.signupEnabled),
    PASSKEY_ENABLED: String(config.passkeyEnabled),
    TOTP_ENABLED: String(config.totpEnabled),
    EMAIL_ENABLED: String(config.emailEnabled),
    MAINTENANCE_ENABLED: String(config.maintenanceEnabled),
    MAINTENANCE_CRON: config.maintenanceCron,
    ...(config.emailEnabled
      ? {
          SMTP_HOST: process.env.SMTP_HOST,
          SMTP_PORT: process.env.SMTP_PORT,
          SMTP_SECURE: process.env.SMTP_SECURE,
          SMTP_USER: process.env.SMTP_USER,
          SMTP_PASSWORD: process.env.SMTP_PASSWORD,
          SMTP_FROM: process.env.SMTP_FROM,
        }
      : {}),
    ...pickOptionalEnv([
      "TRASH_RETENTION_DAYS",
      "MAX_PAST_VERSIONS",
      "GC_GRACE_DAYS",
      "GC_BATCH_SIZE",
    ]),
    __authPoolOverride: authPool,
    __storageRoot: config.storageRoot,
  } as Env & { __authPoolOverride: pg.Pool; __storageRoot: string };
}

function pickOptionalEnv(keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") {
      out[key] = value;
    }
  }
  return out;
}
