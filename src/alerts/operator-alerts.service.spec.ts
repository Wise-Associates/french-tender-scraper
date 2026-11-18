import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmtpConfig } from '../ao-mail/ao-mailer';
import { TendersRepository } from '../tenders/tenders.repository';
import { OperatorAlert, REMINDER_INTERVAL_MS } from './operator-alerts';
import { AlertMailer, OperatorAlertsService } from './operator-alerts.service';

// Fictitious settings; the database and the SMTP server are replaced by fakes.
const SMTP = {
  SMTP_HOST: 'smtp.example.test',
  SMTP_USER: 'veille@acme.test',
  SMTP_PASSWORD: 'not-a-real-password',
  MAIL_FROM: 'Veille <veille@acme.test>',
};
const alert: OperatorAlert = { kind: 'session:partenaire-gc', subject: 'Session expirée', text: 'Reconnectez-vous.' };
const now = new Date('2026-11-18T07:00:00.000Z');

function setup(options: { env?: Record<string, string | undefined>; sendError?: Error } = {}) {
  const env = options.env ?? { ...SMTP, ALERTS_TO: 'operateur@example.test' };
  const state = new Map<string, string>();
  const sent: { to: string; subject: string; config: SmtpConfig }[] = [];
  const repository = {
    alertLastSentAt: (kind: string) => state.get(kind) ?? null,
    markAlertSent: (kind: string, at: string) => state.set(kind, at),
    clearAlert: (kind: string) => state.delete(kind),
  } as unknown as TendersRepository;
  const mailer = {
    send: async (config: SmtpConfig, to: string, message: OperatorAlert) => {
      if (options.sendError) throw options.sendError;
      sent.push({ to, subject: message.subject, config });
    },
  } as AlertMailer;
  const config = { get: (key: string) => env[key] } as ConfigService;
  return { service: new OperatorAlertsService(repository, config, mailer), sent, state };
}

describe('OperatorAlertsService', () => {
  it('refuses to start with an invalid ALERTS_TO', () => {
    assert.throws(() => setup({ env: { ...SMTP, ALERTS_TO: 'operateur' } }), /ALERTS_TO/);
  });

  it('emails the first occurrence, then at most one reminder per interval', async () => {
    const { service, sent, state } = setup();
    await service.raise(alert, now);
    assert.deepEqual(sent.map((s) => [s.to, s.subject]), [['operateur@example.test', 'Session expirée']]);
    assert.equal(sent[0].config.SMTP_PORT, 587);
    assert.equal(state.get('session:partenaire-gc'), now.toISOString());

    await service.raise(alert, new Date(now.getTime() + 4 * 3_600_000));
    assert.equal(sent.length, 1, 'no email at the next run of the day');

    await service.raise(alert, new Date(now.getTime() + REMINDER_INTERVAL_MS));
    assert.equal(sent.length, 2, 'daily reminder');
  });

  it('emails again at once after the problem was resolved', async () => {
    const { service, sent } = setup();
    await service.raise(alert, now);
    service.resolve('session:partenaire-gc');
    await service.raise(alert, new Date(now.getTime() + 3_600_000));
    assert.equal(sent.length, 2);
  });

  it('sends nothing when ALERTS_TO is empty', async () => {
    const { service, sent, state } = setup({ env: { ...SMTP } });
    await service.raise(alert, now);
    assert.deepEqual(sent, []);
    assert.equal(state.size, 0);
  });

  it('never fails the run, and retries an email that could not be sent', async () => {
    const failing = setup({ sendError: new Error('SMTP login refused') });
    await failing.service.raise(alert, now);
    assert.equal(failing.state.size, 0, 'not recorded, so the next run tries again');

    const refused = setup({ sendError: new Error("Can't send mail - all recipients were rejected: 550 5.1.1 <operateur@example.test>: unknown") });
    const logged = mock.method(Logger.prototype, 'error', () => undefined);
    try {
      await refused.service.raise(alert, now);
      const line = String(logged.mock.calls[0]?.arguments[0]);
      assert.match(line, /550 5\.1\.1/);
      assert.doesNotMatch(line, /operateur@example\.test/, 'ALERTS_TO is never logged');
    } finally {
      logged.mock.restore();
    }

    const misconfigured = setup({ env: { ALERTS_TO: 'operateur@example.test' } });
    await misconfigured.service.raise(alert, now);
    assert.deepEqual(misconfigured.sent, []);
  });
});
