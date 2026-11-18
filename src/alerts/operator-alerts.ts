import { z } from 'zod';
import { SiteKey } from '../scrapers/tender.types';

/** Problems only a person can fix, emailed to ALERTS_TO (ADR 0005). */
export type AlertKind = `session:${SiteKey}` | 'claude-credits';

export const CLAUDE_CREDITS_ALERT: AlertKind = 'claude-credits';

export function sessionAlertKind(site: SiteKey): AlertKind {
  return `session:${site}`;
}

export interface OperatorAlert {
  kind: AlertKind;
  subject: string;
  text: string;
}

/**
 * Minimum gap between two emails of the same kind while the problem lasts. A
 * little under a day, so the daily reminder lands at the same scheduled run
 * each day even if runs start a few minutes late.
 */
export const REMINDER_INTERVAL_MS = 20 * 60 * 60 * 1000;

/** First occurrence (never sent), or the previous email is old enough to remind. */
export function isReminderDue(lastSentAt: string | null, now: Date): boolean {
  if (lastSentAt === null) return true;
  const last = Date.parse(lastSentAt);
  // An unreadable date must not silence the alert for good.
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= REMINDER_INTERVAL_MS;
}

/** ALERTS_TO: empty means no alert email; anything else must be one address (checked at startup). */
export function parseAlertsTo(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!z.email().safeParse(value).success) {
    throw new Error('ALERTS_TO must be one email address (or empty to disable alert emails)');
  }
  return value;
}

const parisDate = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'full', timeStyle: 'short' });

const SIGNATURE = [
  'Ce rappel est renvoyé au plus une fois par jour tant que le problème persiste.',
  '',
  "— Scraper d'appels d'offres Wise Associates",
];

export function sessionExpiredAlert(site: SiteKey, siteName: string, now: Date): OperatorAlert {
  return {
    kind: sessionAlertKind(site),
    subject: `Scraper AO : session ${siteName} expirée, reconnexion nécessaire`,
    text: [
      'Bonjour,',
      '',
      `Le scraper d'appels d'offres n'a plus accès à ${siteName} : la session enregistrée est absente ou a expiré`,
      `(constaté le ${parisDate.format(now)}). Les nouvelles offres de ce site ne sont plus relevées ni envoyées`,
      "à la boîte AO tant que la session n'est pas renouvelée.",
      '',
      'Pour la renouveler, sur votre poste, dans le dossier french-tender-scraper :',
      '',
      `  npm run build && npm run login:session -- ${site}`,
      '',
      "Connectez-vous dans la fenêtre qui s'ouvre, puis appuyez sur Entrée dans le terminal.",
      'Si le scraper tourne sur le VPS, envoyez ensuite la session au serveur (docs/deployment-vps.md, partie 6) :',
      '',
      `  scp sessions/${site}.json <admin>@<ip>:`,
      `  ssh -t <admin>@<ip> 'sudo -u deploy tender-scraper-deploy session < ${site}.json; rm -f ${site}.json'`,
      '',
      ...SIGNATURE,
    ].join('\n'),
  };
}

/**
 * `problem`: Claude's refusal (status, error type, message — no secret in it).
 * `fallback`: the OpenAI fallback, when it was tried this run, with the
 * number of answers it gave. `stopped`: why the analysis stopped, if it did.
 */
export function claudeCreditsAlert(
  problem: string,
  fallback: { model: string; answers: number } | undefined,
  stopped: string | undefined,
  now: Date,
): OperatorAlert {
  const tookOver = fallback !== undefined && fallback.answers > 0;
  return {
    kind: CLAUDE_CREDITS_ALERT,
    subject: tookOver
      ? `Scraper AO : crédits Claude, analyse des offres basculée sur ${fallback.model}`
      : 'Scraper AO : crédits Claude, analyse des offres arrêtée',
    text: [
      'Bonjour,',
      '',
      "L'API Claude refuse l'analyse des offres pour une raison de facturation (crédits épuisés, plafond de",
      `dépenses atteint ou problème de paiement), constaté le ${parisDate.format(now)}.`,
      `Réponse de l'API : ${problem}`,
      '',
      fallbackStatus(fallback, stopped),
      '',
      'À faire : rechargez les crédits (rubrique Billing) ou relevez la limite de dépenses dans la console Claude :',
      'https://platform.claude.com/settings/spend-limits',
      '',
      ...SIGNATURE,
    ].join('\n'),
  };
}

function fallbackStatus(fallback: { model: string; answers: number } | undefined, stopped: string | undefined): string {
  const waiting = 'Les nouvelles offres attendent et seront analysées au premier passage qui aboutit.';
  if (fallback === undefined) {
    return `Aucune solution de secours n'est configurée (OPENAI_API_KEY vide). ${waiting}`;
  }
  if (fallback.answers === 0) {
    return `La solution de secours OpenAI (${fallback.model}) a échoué aussi${stopped ? ` (${stopped})` : ''}. ${waiting}`;
  }
  return (
    `En attendant, OpenAI (${fallback.model}) a analysé ${fallback.answers} offre(s) lors de ce passage` +
    `${stopped ? `, puis l'analyse s'est arrêtée (${stopped})` : ''}. ` +
    "Chaque passage essaie d'abord Claude, qui reprend la main dès que les crédits sont rechargés."
  );
}
