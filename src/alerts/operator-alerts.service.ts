import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { maskContactDetails } from '../analysis/offer-analysis';
import { explainSmtpError, parseSmtpConfig, SmtpConfig, smtpTransportOptions } from '../ao-mail/ao-mailer';
import { TendersRepository } from '../tenders/tenders.repository';
import { AlertKind, isReminderDue, OperatorAlert, parseAlertsTo } from './operator-alerts';

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'] as const;

/** Sends one alert over its own SMTP connection (alerts are rare). */
@Injectable()
export class AlertMailer {
  async send(config: SmtpConfig, to: string, alert: OperatorAlert): Promise<void> {
    const transport = nodemailer.createTransport(smtpTransportOptions(config));
    try {
      const info = await transport
        .sendMail({ from: config.MAIL_FROM, to, subject: alert.subject, text: alert.text })
        .catch((error: unknown) => {
          throw explainSmtpError(error);
        });
      if ((info.rejected ?? []).length > 0) throw new Error('The SMTP server refused ALERTS_TO: check the address.');
    } finally {
      transport.close();
    }
  }
}

/**
 * Emails ALERTS_TO when something only a person can fix blocks the scraper
 * (ADR 0005): first occurrence at once, then a reminder at most every
 * REMINDER_INTERVAL_MS while it lasts. The address is never logged.
 */
@Injectable()
export class OperatorAlertsService {
  private readonly logger = new Logger(OperatorAlertsService.name);
  private readonly to?: string;

  constructor(
    private readonly repository: TendersRepository,
    private readonly config: ConfigService,
    private readonly mailer: AlertMailer,
  ) {
    // Validated at startup: a typo must not silently disable the alerts.
    this.to = parseAlertsTo(config.get<string>('ALERTS_TO'));
    if (!this.to) this.logger.warn('ALERTS_TO is empty: expired sessions and Claude credit problems are only logged');
  }

  /**
   * Never throws: a failed alert must not fail the run. An email that could
   * not be sent is not recorded, so the next run tries again.
   */
  async raise(alert: OperatorAlert, now: Date): Promise<void> {
    if (!this.to) {
      this.logger.warn(`Alert "${alert.subject}" not emailed: ALERTS_TO is empty`);
      return;
    }
    try {
      if (!isReminderDue(this.repository.alertLastSentAt(alert.kind), now)) return;
      const smtp = parseSmtpConfig(Object.fromEntries(SMTP_KEYS.map((key) => [key, this.config.get<string>(key)])));
      await this.mailer.send(smtp, this.to, alert);
      this.repository.markAlertSent(alert.kind, now.toISOString());
      this.logger.log(`Alert "${alert.subject}" emailed to ALERTS_TO`);
    } catch (err) {
      // The SMTP server's refusal usually quotes the recipient: keep ALERTS_TO out of the logs.
      this.logger.error(`Alert "${alert.subject}" not emailed, retried at the next run: ${maskContactDetails(message(err))}`);
    }
  }

  /** The problem is gone: the next occurrence is emailed at once. Never throws, like raise(). */
  resolve(kind: AlertKind): void {
    try {
      if (this.repository.alertLastSentAt(kind) === null) return;
      this.repository.clearAlert(kind);
      this.logger.log(`Alert ${kind} resolved`);
    } catch (err) {
      this.logger.error(`Alert ${kind} could not be marked resolved: ${message(err)}`);
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
