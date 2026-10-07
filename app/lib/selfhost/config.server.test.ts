import { describe, expect, it } from "vitest";
import { readSelfHostConfig } from "./config.server";

describe("readSelfHostConfig", () => {
  it("reads required runtime settings and defaults app url/port/storage", () => {
    const config = readSelfHostConfig({
      AUTH_SECRET: "a".repeat(64),
      DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
    });

    expect(config).toMatchObject({
      appUrl: "http://localhost:3000",
      authSecret: "a".repeat(64),
      databaseUrl: "postgres://postgres:postgres@db:5432/s2",
      port: 3000,
      signupEnabled: false,
      passkeyEnabled: true,
      totpEnabled: true,
      emailEnabled: false,
      maintenanceEnabled: true,
      maintenanceCron: "0 17 * * *",
    });
    expect(config.storageRoot.endsWith(".selfhost/storage")).toBe(true);
  });

  it("allows disabling maintenance and overriding the cron", () => {
    const config = readSelfHostConfig({
      AUTH_SECRET: "a".repeat(64),
      DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
      MAINTENANCE_ENABLED: "false",
      MAINTENANCE_CRON: "30 3 * * *",
    });
    expect(config.maintenanceEnabled).toBe(false);
    expect(config.maintenanceCron).toBe("30 3 * * *");
  });

  it("rejects invalid maintenance cron", () => {
    expect(() =>
      readSelfHostConfig({
        AUTH_SECRET: "a".repeat(64),
        DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
        MAINTENANCE_CRON: "daily",
      }),
    ).toThrow(/MAINTENANCE_CRON must be a 5-field UTC cron/);
  });

  it("allows self-registration only when explicitly enabled", () => {
    const config = readSelfHostConfig({
      AUTH_SECRET: "a".repeat(64),
      DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
      SIGNUP_ENABLED: "true",
    });

    expect(config.signupEnabled).toBe(true);
  });

  it("disables signup when SIGNUP_ENABLED is false", () => {
    const config = readSelfHostConfig({
      AUTH_SECRET: "a".repeat(64),
      DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
      SIGNUP_ENABLED: "false",
    });

    expect(config.signupEnabled).toBe(false);
  });

  it("allows disabling passkey and TOTP independently", () => {
    const config = readSelfHostConfig({
      AUTH_SECRET: "a".repeat(64),
      DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
      PASSKEY_ENABLED: "false",
      TOTP_ENABLED: "false",
    });

    expect(config.passkeyEnabled).toBe(false);
    expect(config.totpEnabled).toBe(false);
  });

  it("requires SMTP settings when EMAIL_ENABLED is true", () => {
    expect(() =>
      readSelfHostConfig({
        AUTH_SECRET: "a".repeat(64),
        DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
        EMAIL_ENABLED: "true",
      }),
    ).toThrow(/SMTP_HOST is required/);

    const config = readSelfHostConfig({
      AUTH_SECRET: "a".repeat(64),
      DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
      EMAIL_ENABLED: "true",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "noreply@example.com",
    });
    expect(config.emailEnabled).toBe(true);
  });

  it("rejects invalid signup values", () => {
    expect(() =>
      readSelfHostConfig({
        AUTH_SECRET: "a".repeat(64),
        DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
        SIGNUP_ENABLED: "yes",
      }),
    ).toThrow(/SIGNUP_ENABLED must be/);
  });

  it("rejects invalid passkey and TOTP values", () => {
    expect(() =>
      readSelfHostConfig({
        AUTH_SECRET: "a".repeat(64),
        DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
        PASSKEY_ENABLED: "yes",
      }),
    ).toThrow(/PASSKEY_ENABLED must be/);
    expect(() =>
      readSelfHostConfig({
        AUTH_SECRET: "a".repeat(64),
        DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
        TOTP_ENABLED: "maybe",
      }),
    ).toThrow(/TOTP_ENABLED must be/);
  });

  it("rejects invalid ports", () => {
    expect(() =>
      readSelfHostConfig({
        AUTH_SECRET: "a".repeat(64),
        DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
        PORT: "nope",
      }),
    ).toThrow(/PORT must be a TCP port/);
  });

  it("reads custom port and storage root from env", () => {
    const config = readSelfHostConfig({
      AUTH_SECRET: "a".repeat(64),
      DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
      PORT: "4000",
      S2_STORAGE_ROOT: "/tmp/custom-storage",
      APP_URL: "https://s2.example.com",
    });

    expect(config.port).toBe(4000);
    expect(config.appUrl).toBe("https://s2.example.com");
    expect(config.storageRoot).toBe("/tmp/custom-storage");
  });

  it("treats empty SIGNUP_ENABLED as default false", () => {
    const config = readSelfHostConfig({
      AUTH_SECRET: "a".repeat(64),
      DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
      SIGNUP_ENABLED: "",
    });
    expect(config.signupEnabled).toBe(false);
  });

  it("throws when AUTH_SECRET is missing", () => {
    expect(() =>
      readSelfHostConfig({
        DATABASE_URL: "postgres://postgres:postgres@db:5432/s2",
      }),
    ).toThrow(/AUTH_SECRET is required/);
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() =>
      readSelfHostConfig({
        AUTH_SECRET: "a".repeat(64),
      }),
    ).toThrow(/DATABASE_URL is required/);
  });
});
