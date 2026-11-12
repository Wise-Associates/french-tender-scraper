import { Tender } from './tender.types';

/** The only site whose links are followed or put in emails for Partenaire GC offers. */
export const PARTENAIRE_GC_ORIGIN = 'https://partenaire-gc.com';

/**
 * Text of one offer in the Partenaire GC "Consultations en cours" listing, as
 * read from the page (labels such as "Code affaire :" still included).
 * Empty string when the field is absent from the offer.
 */
export interface PartenaireGcRow {
  href: string;
  title: string;
  enseigne: string;
  filiale: string;
  /** ISO 8601 from the <time datetime> attribute. */
  publishedAt: string;
  /** ISO 8601 from the <time datetime> attribute. */
  deadlineAt: string;
  code: string;
  lieu: string;
  tarif: string;
  commission: string;
  delai: string;
}

export function toPartenaireGcTender(row: PartenaireGcRow, pageUrl: string): Tender {
  const url = new URL(row.href, pageUrl);
  const code = stripLabel(row.code, 'Code affaire');
  const lieu = stripLabel(row.lieu, 'Lieu');
  const delai = stripLabel(row.delai, 'Délai règlement');
  return {
    site: 'partenaire-gc',
    // The offer's URL slug, not the "code affaire": some buyers use date-like
    // codes (e.g. "101126") that can repeat, while Drupal keeps URLs unique.
    externalId: url.pathname.split('/').filter(Boolean).pop() ?? url.pathname,
    title: row.title,
    buyer: [row.enseigne, row.filiale].filter(Boolean).join(' — ') || undefined,
    url: url.toString(),
    publishedAt: toIso(row.publishedAt),
    deadlineAt: toIso(row.deadlineAt),
    region: lieu || undefined,
    // The tenders table has no column for these, so they are kept readable here.
    description:
      [
        code && `Code affaire : ${code}`,
        lieu && `Lieu : ${lieu}`,
        row.tarif,
        row.commission,
        delai && `Délai règlement : ${delai}`,
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
    raw: {
      codeAffaire: code,
      enseigne: row.enseigne,
      filiale: row.filiale,
      lieu,
      tarifJournalier: row.tarif,
      commission: row.commission,
      delaiReglement: delai,
    },
  };
}

/**
 * True when no keyword is given, or when at least one keyword appears in the
 * title, buyer or description — ignoring case and accents ("securite" matches
 * "SÉCURITÉ").
 */
export function matchesKeywords(tender: Tender, keywords: string[] = []): boolean {
  const wanted = keywords.map(normalize).filter(Boolean);
  if (wanted.length === 0) return true;
  const haystack = normalize([tender.title, tender.buyer, tender.description].join(' '));
  return wanted.some((keyword) => haystack.includes(keyword));
}

function stripLabel(text: string, label: string): string {
  return text.replace(new RegExp(`^${label}\\s*:\\s*`, 'i'), '').trim();
}

/**
 * ISO 8601 only: Date.parse also accepts other formats and reads a French
 * "12/11/2026" as 11 December, so anything else is dropped, not guessed.
 */
function toIso(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
