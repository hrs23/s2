import { describe, expect, it } from "vitest";
import {
  isEmailEnabled,
  isPasskeyEnabled,
  isSignupEnabled,
  isTotpEnabled,
} from "~/lib/auth/auth-feature-policy";

describe("auth feature policy", () => {
  it.each([
    ["passkey", isPasskeyEnabled, "PASSKEY_ENABLED", true],
    ["totp", isTotpEnabled, "TOTP_ENABLED", true],
    ["email", isEmailEnabled, "EMAIL_ENABLED", false],
  ])("defaults %s to %s when unset", (_name, fn, key, fallback) => {
    expect(fn({})).toBe(fallback);
    expect(fn({ [key]: "" })).toBe(fallback);
  });

  it.each([
    ["passkey", isPasskeyEnabled, "PASSKEY_ENABLED"],
    ["totp", isTotpEnabled, "TOTP_ENABLED"],
    ["email", isEmailEnabled, "EMAIL_ENABLED"],
  ])("accepts true/false for %s", (_name, fn, key) => {
    expect(fn({ [key]: "true" })).toBe(true);
    expect(fn({ [key]: "false" })).toBe(false);
  });

  it.each([
    ["passkey", isPasskeyEnabled, "PASSKEY_ENABLED"],
    ["totp", isTotpEnabled, "TOTP_ENABLED"],
    ["email", isEmailEnabled, "EMAIL_ENABLED"],
  ])("rejects invalid %s values", (_name, fn, key) => {
    expect(() => fn({ [key]: "yes" })).toThrow(/must be "true" or "false"/);
  });
});

describe("isSignupEnabled", () => {
  it("defaults to true when unset", () => {
    expect(isSignupEnabled({})).toBe(true);
  });

  it('parses "true" as true', () => {
    expect(isSignupEnabled({ SIGNUP_ENABLED: "true" })).toBe(true);
  });

  it('parses "false" as false', () => {
    expect(isSignupEnabled({ SIGNUP_ENABLED: "false" })).toBe(false);
  });

  it("throws on unrecognized values (fail-closed on typos)", () => {
    expect(() => isSignupEnabled({ SIGNUP_ENABLED: "0" })).toThrow();
    expect(() => isSignupEnabled({ SIGNUP_ENABLED: "TRUE" })).toThrow();
    expect(() => isSignupEnabled({ SIGNUP_ENABLED: "" })).toThrow();
  });
});
