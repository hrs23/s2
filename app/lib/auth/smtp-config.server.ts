export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string;
  readonly password?: string;
  readonly from: string;
}

type EnvWithSmtp = {
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
};

export function readSmtpConfig(env: EnvWithSmtp): SmtpConfig {
  const host = readRequired(env, "SMTP_HOST");
  const from = readRequired(env, "SMTP_FROM");
  const port = readPort(env.SMTP_PORT, 587);
  const secure = readBoolean(env.SMTP_SECURE, false);
  const user = readOptional(env.SMTP_USER);
  const password = readOptional(env.SMTP_PASSWORD);

  if (user && !password) {
    throw new Error("SMTP_PASSWORD is required when SMTP_USER is set");
  }

  return { host, port, secure, user, password, from };
}

function readRequired(env: EnvWithSmtp, key: keyof EnvWithSmtp): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required when EMAIL_ENABLED=true`);
  }
  return value;
}

function readOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readPort(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`SMTP_PORT must be a TCP port, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function readBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(
    `SMTP_SECURE must be "true" or "false", got ${JSON.stringify(raw)}`,
  );
}
