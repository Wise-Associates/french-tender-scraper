import nodemailer, { Transporter } from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser';
import { z } from 'zod';
import { EmailDocuments } from '../documents/read-documents';
import { RenderedEmail } from './offer-email';

/**
 * Read by MyBestConsultant (src/lib/ao/imap.ts) to file the offer under the
 * « Scraping » source — only for a sender of its own domains. Same headers as
 * the veille (veille-marches-emplois, src/mail/mailer.ts): never rename them
 * without changing MyBestConsultant.
 */
export const VEILLE_HEADER = 'X-Wise-Veille';
export const VEILLE_SOURCE_HEADER = 'X-Wise-Veille-Source';
export const SOURCE_ID = 'partenaire-gc';

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/**
 * SMTP settings, same variable names as the veille so its values can be
 * reused. Shared by the AO inbox sending and the operator alerts (src/alerts).
 */
const SmtpFields = z.object({
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().refine((port) => port === 587 || port === 465, 'must be 587 or 465'),
  SMTP_USER: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
  MAIL_FROM: z.string().min(1),
});
export type SmtpConfig = z.infer<typeof SmtpFields>;

/**
 * The address of MAIL_FROM, read with nodemailer's own parser (a quoted
 * display name such as '"x <a@ours>" <b@other>' must not pass); strict: one
 * entry, with an address. Undefined after reporting the issue otherwise.
 */
function senderAddress(mailFrom: string, ctx: z.RefinementCtx): string | undefined {
  const addresses = addressparser(mailFrom, { flatten: true });
  if (addresses.length !== 1 || !addresses[0].address) {
    ctx.addIssue({
      code: 'custom',
      path: ['MAIL_FROM'],
      message: `must contain exactly one address, found ${addresses.length} (expected form: MAIL_FROM="Name <address>")`,
    });
    return undefined;
  }
  return addresses[0].address;
}

const SmtpConfigSchema = SmtpFields.superRefine((c, ctx) => {
  senderAddress(c.MAIL_FROM, ctx);
});

const MailConfigSchema = SmtpFields.extend({ OFFERS_TO: z.email() })
  // MyBestConsultant takes any other sender for the client of the offer (its
  // ADR 0004). The messages show domains only, never full addresses.
  .superRefine((c, ctx) => {
    const address = senderAddress(c.MAIL_FROM, ctx);
    if (!address) return;
    const from = domainOf(address);
    const to = domainOf(c.OFFERS_TO);
    if (from !== to) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_FROM'],
        message: `is on @${from} but OFFERS_TO is on @${to}: the sender must be on the inbox's domain`,
      });
    }
  });
export type MailConfig = z.infer<typeof MailConfigSchema>;

/** Validates the AO inbox mail settings; the message names the variables to fix, never their values. */
export function parseMailConfig(env: Record<string, string | undefined>): MailConfig {
  return parseSettings(MailConfigSchema, env);
}

/** Validates the SMTP settings alone (operator alerts), with the same messages. */
export function parseSmtpConfig(env: Record<string, string | undefined>): SmtpConfig {
  return parseSettings(SmtpConfigSchema, env);
}

function parseSettings<T>(schema: z.ZodType<T>, env: Record<string, string | undefined>): T {
  const parsed = schema.safeParse({ SMTP_PORT: '587', ...withoutEmpty(env) });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Mail settings missing or invalid in .env — ${problems}`);
  }
  return parsed.data;
}

/**
 * Connection settings: 465 is TLS from the start; otherwise STARTTLS is
 * required, so the password never travels in clear.
 */
export function smtpTransportOptions(config: SmtpConfig) {
  return {
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    requireTLS: config.SMTP_PORT !== 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
  };
}

function withoutEmpty(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => !!entry[1]?.trim()));
}

/** Sends offers to the AO inbox over one SMTP connection, at most one message per second (like the veille). */
export class AoMailer {
  private readonly transport: Transporter;

  constructor(private readonly config: MailConfig) {
    this.transport = nodemailer.createTransport({
      ...smtpTransportOptions(config),
      pool: true,
      maxConnections: 1,
      // IONOS refuses more than 20 messages per connection (seen by the veille).
      maxMessages: 10,
      rateDelta: 1_000,
      rateLimit: 1,
    });
  }

  /** Resolves once the SMTP server accepted the message for OFFERS_TO. `attachments`: the offer's documents (ADR 0007). */
  async sendOffer(email: RenderedEmail, attachments: EmailDocuments['attachments'] = []): Promise<{ messageId: string }> {
    const info = await this.transport
      .sendMail({
        from: this.config.MAIL_FROM,
        to: this.config.OFFERS_TO,
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: { [VEILLE_HEADER]: 'scraping', [VEILLE_SOURCE_HEADER]: SOURCE_ID },
        attachments: attachments.map(({ filename, content, contentType }) => ({ filename, content, contentType })),
      })
      .catch((error: unknown) => {
        throw explainSmtpError(error);
      });
    // nodemailer only rejects when every recipient is refused.
    if ((info.rejected ?? []).length > 0) throw new Error('The SMTP server refused OFFERS_TO: check the address.');
    return { messageId: String(info.messageId) };
  }

  close(): void {
    this.transport.close();
  }
}

/**
 * Names the setting to fix when nodemailer's error says so; the server's reply
 * never contains the password. A temporary refusal (4xx) is checked first: it
 * can come at the login or sender step, and nothing in the settings is wrong.
 */
export function explainSmtpError(error: unknown): unknown {
  const smtp = (error ?? {}) as { code?: unknown; command?: unknown; responseCode?: unknown; message?: unknown };
  if (typeof smtp.responseCode === 'number' && smtp.responseCode >= 400 && smtp.responseCode < 500) {
    return withCause(`Temporary refusal from the SMTP server (sending limit or busy server): try again later (${String(smtp.message)})`, error);
  }
  if (smtp.code === 'EAUTH') {
    return withCause(`SMTP login refused: check SMTP_USER and SMTP_PASSWORD (${String(smtp.message)})`, error);
  }
  if (smtp.command === 'MAIL FROM') {
    return withCause(`Sender refused: MAIL_FROM must be the SMTP_USER mailbox or one of its aliases (${String(smtp.message)})`, error);
  }
  return error;
}

/** Error with the original as `cause` (the ES2021 target has no `new Error(message, { cause })` typing). */
function withCause(message: string, cause: unknown): Error {
  return Object.assign(new Error(message), { cause });
}

/**
 * Permanent refusal of one message (content, size: 5xx after DATA), as opposed
 * to errors that affect every send (connection, login, sender, quota, 4xx):
 * the first can be skipped to send the next offers, the others stop sending.
 * Same rule as the veille (src/mail/mailer.ts).
 */
export function isMessageRejection(error: unknown): boolean {
  const smtp = (error ?? {}) as { code?: unknown; responseCode?: unknown; cause?: unknown };
  const source = (smtp.code === undefined && smtp.cause ? smtp.cause : smtp) as { code?: unknown; responseCode?: unknown };
  return source.code === 'EMESSAGE' && typeof source.responseCode === 'number' && source.responseCode >= 500;
}
