import { DocumentProblem, DocumentSession, downloadDocument } from './document-download';
import {
  CONTENT_TYPES,
  CV_TEMPLATE_REASON,
  DocumentFailure,
  DocumentFormat,
  DocumentLink,
  DocumentText,
  documentFormat,
  isCvTemplate,
  matchesFormat,
  MAX_DOCUMENTS_PROMPT_CHARS,
  MAX_EMAIL_DOCUMENTS_BYTES,
} from './offer-documents';
import { extractTextIsolated } from './document-text';

/** Documents of one offer for its AO inbox email: files to attach, and the others with the reason (listed in the email). */
export interface EmailDocuments {
  attachments: { filename: string; content: Buffer; contentType: string }[];
  notAttached: { name: string; reason: string }[];
}

/** Waits between two requests to the site (BaseScraper.humanDelay). */
type Pause = () => Promise<void>;

/**
 * Reads an offer's documents for the analysis: each one downloaded, its
 * format checked, its text extracted in memory by a child process (PDF and
 * Word only); nothing is kept. Never throws:
 * a document that cannot be read carries the reason, the analysis goes on
 * with the others.
 */
export async function readDocumentsForAnalysis(links: DocumentLink[], session: DocumentSession, pause: Pause): Promise<DocumentText[]> {
  return forEachDocument<DocumentText>(links, session, pause, async (link, format, content) => {
    if (format !== 'pdf' && format !== 'docx') return { ...link, problem: `format ${format} non lu par l’analyse`, failure: 'final' };
    try {
      return { ...link, text: await extractTextIsolated(format, content, MAX_DOCUMENTS_PROMPT_CHARS) };
    } catch (err) {
      return { ...link, problem: `illisible (${err instanceof Error ? err.message : String(err)})`, failure: 'final' };
    }
  }, (link, problem, failure) => ({ ...link, problem, failure }));
}

/**
 * Downloads an offer's documents for its AO inbox email. Text formats only
 * (documentFormat), MAX_EMAIL_DOCUMENTS_BYTES in all; the others are listed
 * with the reason. Never throws: the offer is sent without the documents that
 * could not be fetched (an expired session included).
 */
export async function readDocumentsForEmail(links: DocumentLink[], session: DocumentSession, pause: Pause): Promise<EmailDocuments> {
  const result: EmailDocuments = { attachments: [], notAttached: [] };
  let total = 0;
  await forEachDocument(links, session, pause, async (link, format, content) => {
    if (total + content.length > MAX_EMAIL_DOCUMENTS_BYTES) {
      result.notAttached.push({ name: link.name, reason: 'trop lourd pour le même e-mail, à télécharger sur l’offre en ligne' });
      return;
    }
    total += content.length;
    result.attachments.push({ filename: link.name, content, contentType: CONTENT_TYPES[format] });
  }, (link, reason) => {
    result.notAttached.push({ name: link.name, reason });
  });
  return result;
}

/**
 * Downloads each document whose name has a supported format, one at a time
 * with a pause before each request, and hands it to `onDocument`; the others
 * go to `onProblem`. After a refusal or a redirect (expired session), the
 * remaining documents are not requested.
 */
async function forEachDocument<T>(
  links: DocumentLink[],
  session: DocumentSession,
  pause: Pause,
  onDocument: (link: DocumentLink, format: DocumentFormat, content: Buffer) => Promise<T>,
  onProblem: (link: DocumentLink, problem: string, failure: DocumentFailure) => T,
): Promise<T[]> {
  const results: T[] = [];
  let sessionLost: string | undefined;
  for (const link of links) {
    if (isCvTemplate(link.name)) {
      results.push(onProblem(link, CV_TEMPLATE_REASON, 'final'));
      continue;
    }
    const known = documentFormat(link.name);
    if ('problem' in known) {
      results.push(onProblem(link, known.problem, 'final'));
      continue;
    }
    if (sessionLost) {
      results.push(onProblem(link, sessionLost, 'session'));
      continue;
    }
    await pause();
    let content: Buffer;
    try {
      content = await downloadDocument(link, session);
    } catch (err) {
      if (!(err instanceof DocumentProblem)) throw err;
      if (err.failure === 'session') sessionLost = err.message;
      results.push(onProblem(link, err.message, err.failure));
      continue;
    }
    if (!matchesFormat(known.format, content)) {
      results.push(onProblem(link, `le fichier reçu n’est pas un document ${known.format} (session expirée ?)`, 'final'));
      continue;
    }
    results.push(await onDocument(link, known.format, content));
  }
  return results;
}
