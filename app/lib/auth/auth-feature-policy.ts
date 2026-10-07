// Optional auth feature gates. The self-host runtime supplies
// explicit values; local development keeps signup, passkey and TOTP enabled
// when unset.
//
// Parse is strict: typos throw rather than silently failing open.

function readBooleanEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const value = env[key];
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(
    `${key} must be "true" or "false", got ${JSON.stringify(value)}`,
  );
}

export function isSignupEnabled(env: { SIGNUP_ENABLED?: string }): boolean {
  if (env.SIGNUP_ENABLED === "") {
    throw new Error('SIGNUP_ENABLED must be "true" or "false", got ""');
  }
  return readBooleanEnv(env, "SIGNUP_ENABLED", true);
}

export function isPasskeyEnabled(env: { PASSKEY_ENABLED?: string }): boolean {
  return readBooleanEnv(env, "PASSKEY_ENABLED", true);
}

export function isTotpEnabled(env: { TOTP_ENABLED?: string }): boolean {
  return readBooleanEnv(env, "TOTP_ENABLED", true);
}

export function isEmailEnabled(env: { EMAIL_ENABLED?: string }): boolean {
  return readBooleanEnv(env, "EMAIL_ENABLED", false);
}
