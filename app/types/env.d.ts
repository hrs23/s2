// Runtime environment for the Node self-host path (dev, test, production).
declare const __S2_VERSION__: string;

interface Env {
  AUTH_SECRET: string;
  APP_URL: string;
  DATABASE_URL?: string;
  AUTH_STORAGE: import("better-auth").SecondaryStorage;
  /** "false" rejects new sign-ups; existing users still log in. Self-host default: false. */
  SIGNUP_ENABLED?: string;
  /**
   * Passkey (WebAuthn) feature gate. Unset = enabled; "false" hides
   * passkey UI and omits the Better Auth passkey plugin.
   */
  PASSKEY_ENABLED?: string;
  /**
   * TOTP + recovery-code feature gate. Unset = enabled; "false"
   * hides 2FA UI and omits the Better Auth twoFactor plugin.
   */
  TOTP_ENABLED?: string;
  /**
   * Email verification + password reset feature gate. Unset = disabled;
   * "true" enables SMTP-backed mail flows and requires SMTP_* env vars.
   */
  EMAIL_ENABLED?: string;
  /** SMTP relay host (required when EMAIL_ENABLED=true). */
  SMTP_HOST?: string;
  /** SMTP relay port. Defaults to 587. */
  SMTP_PORT?: string;
  /** Use implicit TLS (SMTPS). Defaults to false (STARTTLS on port 587). */
  SMTP_SECURE?: string;
  /** SMTP AUTH username (optional). */
  SMTP_USER?: string;
  /** SMTP AUTH password (required when SMTP_USER is set). */
  SMTP_PASSWORD?: string;
  /** From address for outbound mail (required when EMAIL_ENABLED=true). */
  SMTP_FROM?: string;
  /**
   * Daily maintenance scheduler gate. Unset = enabled; "false"
   * disables the in-process Node cron ticker.
   */
  MAINTENANCE_ENABLED?: string;
  /**
   * 5-field UTC cron for daily maintenance. Default `0 17 * * *`
   * (02:00 JST).
   */
  MAINTENANCE_CRON?: string;
  /** Days before a trashed file is purged (cron). */
  TRASH_RETENTION_DAYS?: string;
  /** Past revisions to keep per file (0 = disabled). */
  MAX_PAST_VERSIONS?: string;
  /** Days a storage_tombstones row sits before GC deletes blobs. */
  GC_GRACE_DAYS?: string;
  /** Max tombstones GC processes per run. */
  GC_BATCH_SIZE?: string;
  /** RFC 8707 audience allowlist for OAuth `resource` indicators. */
  ALLOWED_RESOURCES?: string;
}
