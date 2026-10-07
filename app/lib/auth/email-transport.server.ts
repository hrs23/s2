import nodemailer from "nodemailer";
import type { SmtpConfig } from "~/lib/auth/smtp-config.server";

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export type EmailTransport = (message: EmailMessage) => Promise<void>;

export function createSmtpTransport(config: SmtpConfig): EmailTransport {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth:
      config.user && config.password
        ? { user: config.user, pass: config.password }
        : undefined,
  });

  return async (message) => {
    await transporter.sendMail({
      from: config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  };
}

export function createCaptureEmailTransport(
  sink: EmailMessage[],
): EmailTransport {
  return async (message) => {
    sink.push(message);
  };
}
