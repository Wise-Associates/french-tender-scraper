// E-mail of one offer for MyBestConsultant's AO inbox. Same layout as the
// veille's offer emails (veille-marches-emplois, src/digest/offer-email.ts):
// MyBestConsultant's AI reads one offer per email, and its extraction expects
// the labels « Intitulé », « Client », « Lieu », « Date limite de réponse ».
// « Client » must name the buyer: an email sent from our own domain takes its
// client from the text (MyBestConsultant ADR 0004). Pure, tested.
import { PARTENAIRE_GC_ORIGIN } from '../scrapers/partenaire-gc.listing';
import { TenderWithAnalysis } from '../tenders/tenders.repository';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const KIND_LABEL = "Appel d'offres";
/** Kept readable in mail clients. */
const MAX_SUBJECT = 180;
const FOOTER =
  "Offre relevée automatiquement dans l'espace abonné Partenaire GC et retenue par l'analyse automatique des offres.";

const STYLE = {
  body: 'font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:14px;line-height:1.5;max-width:720px',
  h1: 'font-size:20px;margin:0 0 16px',
  h2: 'font-size:17px;margin:24px 0 8px;border-bottom:1px solid #d1d5db;padding-bottom:4px',
  muted: 'color:#6b7280;font-size:12px',
  label: 'color:#4b5563;padding:2px 12px 2px 0;vertical-align:top;white-space:nowrap',
};

type Field = { label: string; value: string; href?: string };

/** « 19/11/2026 à 13:00 », Paris time — the veille's format. */
export function frenchDeadline(iso: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  const day = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric' }).format(instant);
  const time = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(instant);
  return `${day} à ${time}`;
}

export function renderOfferEmail(offer: TenderWithAnalysis): RenderedEmail {
  const client = offer.buyer ?? 'Client non précisé';
  const url = siteUrl(offer.site, offer.url);
  const skills = offer.analysis?.skills ?? [];
  const fields: Field[] = [
    { label: 'Intitulé', value: offer.title },
    { label: 'Client', value: client },
    ...(offer.region ? [{ label: 'Lieu', value: offer.region }] : []),
    ...(offer.description ? [{ label: 'Précisions', value: offer.description }] : []),
    ...(skills.length ? [{ label: 'Compétences', value: skills.join(', ') }] : []),
    ...(offer.deadline_at ? [{ label: 'Date limite de réponse', value: frenchDeadline(offer.deadline_at) }] : []),
    { label: 'Référence', value: `${offer.site}:${offer.external_id}` },
    url ? { label: 'Offre en ligne', value: url, href: url } : { label: 'Offre en ligne', value: 'lien indisponible' },
  ];
  const description =
    offer.analysis?.missionText?.trim() || "Pas de description enregistrée : voir l'offre en ligne.";
  const subject = `${KIND_LABEL} — ${client} — ${offer.title}`.replace(/\s+/g, ' ');

  const text = [
    `${KIND_LABEL} — ${client}`,
    '',
    ...fields.map(({ label, value }) => `${label} : ${value}`),
    '',
    'Description',
    '-----------',
    description,
    '',
    '--',
    FOOTER,
  ].join('\n');

  const rows = fields
    .map(({ label, value, href }) => {
      const cell = href ? `<a href="${escapeHtml(href)}">${escapeHtml(value)}</a>` : escapeHtml(value);
      return `<tr><td style="${STYLE.label}">${escapeHtml(label)}</td><td>${cell}</td></tr>`;
    })
    .join('\n');
  const paragraphs = description
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).split('\n').join('<br>')}</p>`)
    .join('\n');
  const html = [
    `<div style="${STYLE.body}">`,
    `<h1 style="${STYLE.h1}">${escapeHtml(KIND_LABEL)} — ${escapeHtml(client)}</h1>`,
    `<table>${rows}</table>`,
    `<h2 style="${STYLE.h2}">Description</h2>`,
    paragraphs,
    `<p style="${STYLE.muted}">${escapeHtml(FOOTER)}</p>`,
    '</div>',
  ].join('\n');

  return {
    subject: subject.length > MAX_SUBJECT ? `${subject.slice(0, MAX_SUBJECT - 1)}…` : subject,
    text,
    html,
  };
}

/** Offer texts come from a third-party site: everything is escaped. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Offer links must point to the offer's own site: a link from a compromised or
 * altered listing would otherwise reach the AO inbox (phishing). Same rule as
 * the veille.
 */
const SITE_ORIGINS: Record<string, string> = { 'partenaire-gc': PARTENAIRE_GC_ORIGIN };

function siteUrl(site: string, value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === SITE_ORIGINS[site] ? url.href : null;
  } catch {
    return null;
  }
}
