import { DocumentFailure, DocumentLink, MAX_DOCUMENT_BYTES } from './offer-documents';

/** Per document; the documents seen in November 2026 weighed 50 to 200 KB. */
export const DOWNLOAD_TIMEOUT_MS = 30_000;

/** How a document is requested with the site's session: its cookies for a URL, and the browser's user agent. */
export interface DocumentSession {
  cookie(url: string): Promise<string>;
  userAgent: string;
}

/**
 * A document could not be downloaded; the message is shown in the AO inbox
 * email. `failure` says whether trying again can help (DocumentFailure).
 */
export class DocumentProblem extends Error {
  constructor(message: string, readonly failure: DocumentFailure) {
    super(message);
  }
}

/** Statuses a later request may not get: the site is busy or down. */
const TEMPORARY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Downloads one document with the session's cookies. Redirects are not
 * followed (the cookie must not reach another site; a redirect to the login
 * page means the session expired), and the size limit is checked while
 * reading, not only from Content-Length.
 */
export async function downloadDocument(
  link: DocumentLink,
  session: DocumentSession,
  { maxBytes = MAX_DOCUMENT_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(link.url, {
        headers: { cookie: await session.cookie(link.url), 'user-agent': session.userAgent },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      const reason = controller.signal.aborted ? 'délai de téléchargement dépassé' : `téléchargement impossible (${messageOf(err)})`;
      throw new DocumentProblem(reason, 'temporary');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new DocumentProblem('le site a redirigé vers une autre page (session expirée ?)', 'session');
    }
    if (response.status === 401 || response.status === 403) {
      throw new DocumentProblem(`accès refusé par le site, HTTP ${response.status} (session expirée ?)`, 'session');
    }
    if (TEMPORARY_STATUSES.has(response.status)) throw new DocumentProblem(`HTTP ${response.status}`, 'temporary');
    if (response.status !== 200 || !response.body) throw new DocumentProblem(`HTTP ${response.status}`, 'final');
    const announced = Number(response.headers.get('content-length'));
    if (announced > maxBytes) {
      controller.abort();
      throw new DocumentProblem(tooLarge(maxBytes), 'final');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          controller.abort();
          throw new DocumentProblem(tooLarge(maxBytes), 'final');
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof DocumentProblem) throw err;
      const reason = controller.signal.aborted ? 'délai de téléchargement dépassé' : `téléchargement interrompu (${messageOf(err)})`;
      throw new DocumentProblem(reason, 'temporary');
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
  }
}

function tooLarge(maxBytes: number): string {
  return `plus de ${Math.round(maxBytes / (1024 * 1024))} Mo, à télécharger sur l’offre en ligne`;
}

function messageOf(err: unknown): string {
  const error = err as { message?: unknown; cause?: { code?: unknown } };
  // undici's message is just "fetch failed": the cause carries the reason (ECONNRESET, ENOTFOUND…).
  const code = typeof error?.cause?.code === 'string' ? error.cause.code : '';
  return [typeof error?.message === 'string' ? error.message : String(err), code].filter(Boolean).join(', ');
}
