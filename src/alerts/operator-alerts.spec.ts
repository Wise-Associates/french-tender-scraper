import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeCreditsAlert, isReminderDue, parseAlertsTo, REMINDER_INTERVAL_MS, sessionExpiredAlert } from './operator-alerts';

const now = new Date('2026-11-18T07:00:00.000Z'); // 08:00 in Paris
const hoursBefore = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

describe('isReminderDue', () => {
  it('sends the first occurrence at once', () => {
    assert.equal(isReminderDue(null, now), true);
  });

  it('reminds at the same scheduled run the next day, not at the runs in between', () => {
    for (const hours of [4, 8, 12, 19.9]) assert.equal(isReminderDue(hoursBefore(hours), now), false, `${hours} h`);
    assert.equal(isReminderDue(hoursBefore(REMINDER_INTERVAL_MS / 3_600_000), now), true);
    // A run starting a few minutes earlier than the previous day's still reminds.
    assert.equal(isReminderDue(hoursBefore(23.9), now), true);
  });

  it('does not stay silent on an unreadable date', () => {
    assert.equal(isReminderDue('not a date', now), true);
  });
});

describe('parseAlertsTo', () => {
  it('is disabled when empty', () => {
    assert.equal(parseAlertsTo(undefined), undefined);
    assert.equal(parseAlertsTo('  '), undefined);
  });

  it('accepts one address and refuses anything else', () => {
    assert.equal(parseAlertsTo(' operateur@example.test '), 'operateur@example.test');
    assert.throws(() => parseAlertsTo('operateur@example'), /ALERTS_TO must be one email address/);
    assert.throws(() => parseAlertsTo('a@example.test, b@example.test'), /ALERTS_TO/);
  });
});

describe('sessionExpiredAlert', () => {
  it('says what stopped, when (Paris time) and the commands that fix it', () => {
    const alert = sessionExpiredAlert('partenaire-gc', 'Partenaire GC (espace abonné)', now);
    assert.equal(alert.kind, 'session:partenaire-gc');
    assert.match(alert.subject, /session Partenaire GC \(espace abonné\) expirée/);
    assert.match(alert.text, /mercredi 18 novembre 2026 (à )?08:00/);
    assert.match(alert.text, /npm run login:session -- partenaire-gc/);
    assert.match(alert.text, /tender-scraper-deploy session < partenaire-gc\.json/);
  });
});

describe('claudeCreditsAlert', () => {
  const problem = 'Claude API 402 (billing_error): Your credit balance is too low';

  it('tells that the OpenAI fallback took over', () => {
    const alert = claudeCreditsAlert(problem, { model: 'gpt-6-luna', answers: 3 }, undefined, now);
    assert.equal(alert.kind, 'claude-credits');
    assert.match(alert.subject, /basculée sur gpt-6-luna/);
    assert.match(alert.text, /a analysé 3 offre\(s\)/);
    assert.match(alert.text, /credit balance is too low/);
  });

  it('tells that the analysis stopped when there is no fallback', () => {
    const alert = claudeCreditsAlert(problem, undefined, `Analysis stopped: ${problem}`, now);
    assert.match(alert.subject, /arrêtée/);
    assert.match(alert.text, /OPENAI_API_KEY vide/);
  });

  it('does not claim OpenAI took over when it failed too', () => {
    const alert = claudeCreditsAlert(problem, { model: 'gpt-6-luna', answers: 0 }, 'Analysis stopped: OpenAI API 401: OPENAI_API_KEY refused', now);
    assert.match(alert.subject, /arrêtée/);
    assert.match(alert.text, /gpt-6-luna\) a échoué aussi \(Analysis stopped: OpenAI API 401/);
    assert.doesNotMatch(alert.text, /a analysé/);
  });
});
