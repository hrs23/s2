import path from "node:path";
import { readSmtpConfig } from "~/lib/auth/smtp-config.server";
import { DAILY_CRON } from "~/lib/cron/daily-maintenance.server";

export interface SelfHostConfig {
  readonly appUrl: string;
  readonly authSecret: string;
  readonly databaseUrl: string;
  readonly port: number;
  readonly signupEnabled: boolean;
  readonly passkeyEnabled: boolean;
  readonly totpEnabled: boolean;
  readonly emailEnabled: boolean;
  readonly maintenanceEnabled: boolean;
  readonly maintenanceCron: string;
  readonly storageRoot: string;
}

type SelfHostProcessEnv = Record<string, string | undefined>;

export function readSelfHostConfig(
  env: SelfHostProcessEnv = process.env,
): SelfHostConfig {
  const emailEnabled = readBoolean(env, "EMAIL_ENABLED", false);
  if (emailEnabled) {
    readSmtpConfig(env);
  }

  return {
    appUrl: readString(env, "APP_URL", "http://localhost:3000"),
    authSecret: readRequired(env, "AUTH_SECRET"),
    databaseUrl: readRequired(env, "DATABASE_URL"),
    port: readPort(env, "PORT", 3000),
    signupEnabled: readBoolean(env, "SIGNUP_ENABLED", false),
    passkeyEnabled: readBoolean(env, "PASSKEY_ENABLED", true),
    totpEnabled: readBoolean(env, "TOTP_ENABLED", true),
    emailEnabled,
    maintenanceEnabled: readBoolean(env, "MAINTENANCE_ENABLED", true),
    maintenanceCron: readCron(env, "MAINTENANCE_CRON", DAILY_CRON),
    storageRoot: path.resolve(
      readString(env, "S2_STORAGE_ROOT", ".selfhost/storage"),
    ),
  };
}

function readBoolean(
  env: SelfHostProcessEnv,
  key: string,
  fallback: boolean,
): boolean {
  const value = env[key];
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${key} must be "true" or "false"`);
}

function readRequired(env: SelfHostProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function readString(
  env: SelfHostProcessEnv,
  key: string,
  fallback: string,
): string {
  const value = env[key];
  return value && value.length > 0 ? value : fallback;
}

function readPort(
  env: SelfHostProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${key} must be a TCP port, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function readCron(
  env: SelfHostProcessEnv,
  key: string,
  fallback: string,
): string {
  const value = env[key];
  const cron = value && value.length > 0 ? value : fallback;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `${key} must be a 5-field UTC cron, got ${JSON.stringify(cron)}`,
    );
  }
  return cron.trim();
}
