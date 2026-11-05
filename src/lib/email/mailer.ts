// What the app needs to send an email. The SMTP adapter in src/lib/platform implements it; a
// provider's own API could implement the same shape.
export type Email = { to: string; subject: string; text: string; html: string };

export interface Mailer {
  /** Sends one email. Returns the provider's message ID. Throws if the provider refuses it. */
  send(email: Email): Promise<string>;
}
