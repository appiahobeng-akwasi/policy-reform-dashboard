// Outgoing email by SMTP: Mailpit locally, a transactional provider's SMTP relay when hosted.
// The only file that talks to the mail server (CLAUDE.md rule 7).
import nodemailer from 'nodemailer';
import type { Mailer } from '../email/mailer';
import { env } from '../env';

/** Null when no SMTP server is configured: reminders stay in the app. */
export function createMailer(): Mailer | null {
  const smtp = env.smtp;
  if (!smtp) return null;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? '' } } : {}),
    // Never read files or URLs into a message: everything we send is text we built.
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async send(email) {
      const info = await transport.sendMail({ from: smtp.from, to: email.to, subject: email.subject, text: email.text, html: email.html });
      return info.messageId;
    },
  };
}
