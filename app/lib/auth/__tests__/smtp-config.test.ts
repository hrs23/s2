import { describe, expect, it } from "vitest";
import { readSmtpConfig } from "~/lib/auth/smtp-config.server";

describe("readSmtpConfig", () => {
  it("reads required SMTP settings with defaults", () => {
    expect(
      readSmtpConfig({
        SMTP_HOST: "smtp.example.com",
        SMTP_FROM: "S2 <noreply@example.com>",
      }),
    ).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: undefined,
      password: undefined,
      from: "S2 <noreply@example.com>",
    });
  });

  it("reads optional auth and secure settings", () => {
    expect(
      readSmtpConfig({
        SMTP_HOST: "smtp.example.com",
        SMTP_FROM: "noreply@example.com",
        SMTP_PORT: "465",
        SMTP_SECURE: "true",
        SMTP_USER: "mailer",
        SMTP_PASSWORD: "secret",
      }),
    ).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "mailer",
      password: "secret",
      from: "noreply@example.com",
    });
  });

  it("requires SMTP_PASSWORD when SMTP_USER is set", () => {
    expect(() =>
      readSmtpConfig({
        SMTP_HOST: "smtp.example.com",
        SMTP_FROM: "noreply@example.com",
        SMTP_USER: "mailer",
      }),
    ).toThrow(/SMTP_PASSWORD is required/);
  });

  it("rejects missing required keys", () => {
    expect(() => readSmtpConfig({ SMTP_FROM: "noreply@example.com" })).toThrow(
      /SMTP_HOST is required/,
    );
    expect(() => readSmtpConfig({ SMTP_HOST: "smtp.example.com" })).toThrow(
      /SMTP_FROM is required/,
    );
  });
});
