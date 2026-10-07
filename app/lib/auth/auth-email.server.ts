import { isEmailEnabled } from "~/lib/auth/auth-feature-policy";
import {
  createCaptureEmailTransport,
  createSmtpTransport,
  type EmailMessage,
  type EmailTransport,
} from "~/lib/auth/email-transport.server";
import { readSmtpConfig } from "~/lib/auth/smtp-config.server";

type AuthUser = { email: string; name?: string | null };

export interface AuthEmailHandlers {
  readonly sendVerificationEmail: (
    data: { user: AuthUser; url: string; token: string },
    request?: Request,
  ) => Promise<void>;
  readonly sendResetPassword: (
    data: { user: AuthUser; url: string; token: string },
    request?: Request,
  ) => Promise<void>;
}

type EnvWithEmailOverride = Env & {
  __emailTransportOverride?: EmailTransport;
};

function resolveEmailTransport(env: Env): EmailTransport {
  const authEnv = env as EnvWithEmailOverride;
  if (authEnv.__emailTransportOverride) {
    return authEnv.__emailTransportOverride;
  }
  return createSmtpTransport(readSmtpConfig(env));
}

export function createAuthEmailHandlers(env: Env): AuthEmailHandlers {
  if (!isEmailEnabled(env)) {
    throw new Error("createAuthEmailHandlers called while EMAIL_ENABLED=false");
  }

  const transport = resolveEmailTransport(env);

  return {
    sendVerificationEmail: async ({ user, url }) => {
      await transport(buildVerificationEmail(user.email, url));
    },
    sendResetPassword: async ({ user, url }) => {
      await transport(buildPasswordResetEmail(user.email, url));
    },
  };
}

export function createTestEmailCapture(env: Env): {
  env: Env;
  sent: EmailMessage[];
} {
  const sent: EmailMessage[] = [];
  return {
    sent,
    env: {
      ...env,
      EMAIL_ENABLED: "true",
      __emailTransportOverride: createCaptureEmailTransport(sent),
    } as Env,
  };
}

function buildVerificationEmail(to: string, url: string): EmailMessage {
  return {
    to,
    subject: "Verify your S2 email address",
    text: [
      "Verify your email address to finish setting up your S2 account.",
      "",
      url,
      "",
      "If you did not create an S2 account, you can ignore this email.",
    ].join("\n"),
    html: [
      "<p>Verify your email address to finish setting up your S2 account.</p>",
      `<p><a href="${escapeHtml(url)}">Verify email</a></p>`,
      `<p style="color:#666;font-size:12px">If you did not create an S2 account, you can ignore this email.</p>`,
    ].join(""),
  };
}

function buildPasswordResetEmail(to: string, url: string): EmailMessage {
  return {
    to,
    subject: "Reset your S2 password",
    text: [
      "We received a request to reset your S2 password.",
      "",
      url,
      "",
      "If you did not request a password reset, you can ignore this email.",
    ].join("\n"),
    html: [
      "<p>We received a request to reset your S2 password.</p>",
      `<p><a href="${escapeHtml(url)}">Reset password</a></p>`,
      `<p style="color:#666;font-size:12px">If you did not request a password reset, you can ignore this email.</p>`,
    ].join(""),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
