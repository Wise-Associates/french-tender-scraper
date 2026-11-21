// Documents attached to an offer on its detail page (cahier des charges, annexes): which links are followed,
// which files are attached to the AO inbox email, what the analysis receives (ADR 0007). Pure, tested.

/** Links followed per offer; Partenaire GC offers had 1 to 3 documents in November 2026. */
export const MAX_DOCUMENTS_PER_OFFER = 5;
/** Per file: MyBestConsultant skips attachments over 10 MB (src/lib/ao/extractors/office.ts). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** Per email, all attachments together: base64 adds a third, and MyBestConsultant drops messages over 25 MB. */
export const MAX_EMAIL_DOCUMENTS_BYTES = 10 * 1024 * 1024;
/** Document text given to the analysis, all documents together (about 8,000 tokens). */
export const MAX_DOCUMENTS_PROMPT_CHARS = 30_000;

/** A document linked from an offer's detail page; `url` passed documentLinks(). */
export interface DocumentLink {
  name: string;
  url: string;
}

/**
 * Why a document was not read, which decides what happens to its offer:
 * - `final`: left out on purpose or for good (spreadsheet, CV template, 404,
 *   over the size limit, unreadable file): the offer goes on without it;
 * - `temporary`: timeout, network error, server error: worth another try;
 * - `session`: the site refused or redirected, the session has expired.
 */
export type DocumentFailure = 'final' | 'temporary' | 'session';

/** A document as read for the analysis: its text ('' when it has none), or why it was not read. */
export type DocumentText = DocumentLink & ({ text: string } | { problem: string; failure: DocumentFailure });

/**
 * What the analysis does with an offer once its documents were read: go on
 * (every document read, or left out for good), stop the run because the
 * session expired, or leave the offer for the next run. Without this, an offer
 * whose page only says « see the attached cahier des charges » would be judged
 * without its cahier des charges after a mere timeout, and set aside for good.
 */
export function documentsReadOutcome(
  documents: DocumentText[],
): { kind: 'ok' } | { kind: 'session'; problem: string } | { kind: 'retry'; name: string; problem: string } {
  for (const document of documents) {
    if ('problem' in document && document.failure === 'session') return { kind: 'session', problem: document.problem };
  }
  for (const document of documents) {
    if ('problem' in document && document.failure === 'temporary') return { kind: 'retry', name: document.name, problem: document.problem };
  }
  return { kind: 'ok' };
}

/**
 * Formats attached to the AO inbox email: those MyBestConsultant reads as text
 * (src/lib/ao/extractors/office.ts). Spreadsheets are left out on purpose:
 * MyBestConsultant reads an attached spreadsheet as a table of offers, so a CV
 * matrix could become fake offers.
 */
export type DocumentFormat = 'pdf' | 'docx' | 'doc' | 'odt' | 'rtf' | 'pptx';

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** First bytes each format must start with: a login page or an error page saved as « .pdf » is refused. */
const SIGNATURES = new Map<string, Buffer>([
  ['pdf', Buffer.from('%PDF-', 'latin1')],
  ['docx', ZIP],
  ['odt', ZIP],
  ['pptx', ZIP],
  ['doc', OLE],
  ['rtf', Buffer.from('{\\rtf', 'latin1')],
]);
const SPREADSHEETS = new Set(['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'tsv']);

/** Format of a document from its name, before downloading it, or why it is not attached (shown in the email). */
export function documentFormat(name: string): { format: DocumentFormat } | { problem: string } {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (SPREADSHEETS.has(extension)) return { problem: 'tableur, à télécharger sur l’offre en ligne' };
  if (!SIGNATURES.has(extension)) {
    return { problem: `format ${extension ? `« ${extension} » ` : ''}non pris en charge, à télécharger sur l’offre en ligne` };
  }
  return { format: extension as DocumentFormat };
}

/**
 * A CV template to fill (« matrice_cv_fastor_gie… », « modèle CV »): its
 * sample CV (« DBA : ORACLE / POSTGRES, 5 ans d'expérience… », seen in
 * November 2026) would pass for the offer's requirements, both in the
 * analysis and in MyBestConsultant's reading of the email. Not downloaded,
 * listed in the email instead.
 */
export function isCvTemplate(name: string): boolean {
  const words = new Set(
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/),
  );
  return words.has('cv') && (words.has('matrice') || words.has('modele') || words.has('template') || words.has('trame'));
}

export const CV_TEMPLATE_REASON = 'modèle de CV à remplir, à télécharger sur l’offre en ligne';

/** The downloaded bytes start like the format says (MIME types sent by servers are not trusted). */
export function matchesFormat(format: DocumentFormat, content: Buffer): boolean {
  const signature = SIGNATURES.get(format);
  return signature !== undefined && content.subarray(0, signature.length).equals(signature);
}

/** Content-Type of an attachment, from its checked format. */
export const CONTENT_TYPES: Record<DocumentFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/**
 * The offer's document links worth following: on the site's own origin and
 * under Drupal's private files (`/system/files/`) only, so the session cookie
 * is never sent anywhere else; duplicates removed; at most
 * MAX_DOCUMENTS_PER_OFFER. `hrefs` are the raw attributes of the page's links.
 */
export function documentLinks(hrefs: string[], pageUrl: string, origin: string): DocumentLink[] {
  const links: DocumentLink[] = [];
  const seen = new Set<string>();
  for (const href of hrefs) {
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (url.origin !== origin || url.username || url.password || !url.pathname.startsWith('/system/files/')) continue;
    url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    links.push({ name: documentName(url), url: url.href });
    if (links.length >= MAX_DOCUMENTS_PER_OFFER) break;
  }
  return links;
}

/**
 * File name from the link's last path segment, decoded, with anything but
 * letters, digits, spaces and « . _ - ( ) » replaced: it becomes an attachment
 * name and a line of the email. At most 120 characters, extension kept.
 */
export function documentName(url: URL): string {
  const segment = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  const clean = decoded
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} ._()-]/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '');
  if (!clean) return 'document';
  if (clean.length <= 120) return clean;
  const dot = clean.lastIndexOf('.');
  const extension = dot > 0 && clean.length - dot <= 6 ? clean.slice(dot) : '';
  return clean.slice(0, 120 - extension.length) + extension;
}

/**
 * The documents' part of the analysis prompt: each document between
 * delimiters, after `mask` (contact details), the whole block cut at
 * MAX_DOCUMENTS_PROMPT_CHARS with a visible marker. '' without documents.
 */
export function documentsForPrompt(documents: DocumentText[], mask: (text: string) => string, maxChars = MAX_DOCUMENTS_PROMPT_CHARS): string {
  if (documents.length === 0) return '';
  let left = maxChars;
  const blocks = documents.map((document) => {
    const name = document.name.replace(/["<>]/g, '');
    if ('problem' in document) return `<document nom="${name}">(non lu : ${document.problem})</document>`;
    const text = framed(mask(document.text)).trim();
    if (!text) return `<document nom="${name}">(aucun texte lisible)</document>`;
    const kept = text.slice(0, Math.max(0, left));
    left -= kept.length;
    const marker = kept.length < text.length ? '\n[… document tronqué]' : '';
    return `<document nom="${name}">\n${kept}${marker}\n</document>`;
  });
  return ['Documents joints à l’offre :', ...blocks].join('\n');
}

/**
 * Text placed between the prompt's delimiters (`<offre>`, `<document>`): its
 * « < » become « ‹ », so the text cannot close its own frame and pose as
 * instructions. The texts come from the site's buyers.
 */
export function framed(text: string): string {
  return text.replace(/</g, '‹');
}

/** Text of the read documents, for the keyword filter. */
export function documentsText(documents: DocumentText[]): string {
  return documents.map((document) => ('text' in document ? document.text : '')).join('\n');
}
