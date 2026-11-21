import { closeSync, mkdirSync, openSync, rmSync } from 'fs';
import { join } from 'path';
import { DocumentLink } from '../documents/offer-documents';
import { EmailDocuments } from '../documents/read-documents';
import { TendersRepository } from '../tenders/tenders.repository';
import { AoMailer, isMessageRejection, MailConfig } from './ao-mailer';
import { renderOfferEmail } from './offer-email';

/** Most offers emailed in one go (`ao:send` or after a scrape). */
export const MAX_EMAILS_PER_SEND = 50;

/** Downloads an offer's documents with the site's session (BaseScraper.documentsForEmail); never throws. */
export type DocumentsDownloader = (links: DocumentLink[]) => Promise<EmailDocuments>;

/**
 * Emails the relevant offers of `site` not sent yet to the AO inbox, most
 * urgent deadline first, with their documents (ADR 0007). Used by `npm run
 * ao:send` and after each scrape. An offer is recorded once the SMTP server
 * accepted it; a message refused for its content is skipped (retried next
 * time); any other error stops. A document that cannot be downloaded (expired
 * session included) does not hold the offer back: the email lists it.
 */
export async function sendRelevantOffers(
  repository: TendersRepository,
  config: MailConfig,
  site: string,
  limit: number,
  dataDir: string,
  log: (message: string) => void,
  downloadDocuments?: DocumentsDownloader,
): Promise<{ sent: number; refused: number }> {
  const releaseLock = acquireLock(dataDir);
  const mailer = new AoMailer(config);
  let sent = 0;
  let refused = 0;
  try {
    // Selected under the lock: another run may have sent some meanwhile.
    for (const offer of repository.relevantNotEmailed(site, new Date().toISOString(), limit)) {
      const id = `${offer.site}:${offer.external_id}`;
      const documents = await documentsOf(repository.documentLinks(offer.site, offer.external_id), downloadDocuments);
      for (const { name, reason } of documents.notAttached) log(`${id}: document ${name} not attached — ${reason}`);
      const note = { attached: documents.attachments.map((a) => a.filename), notAttached: documents.notAttached };
      let messageId: string;
      try {
        ({ messageId } = await mailer.sendOffer(renderOfferEmail(offer, note), documents.attachments));
      } catch (err) {
        // A message refused for its content must not block the next offers.
        if (!isMessageRejection(err)) throw err;
        refused += 1;
        log(`Refused by the SMTP server, retried next time: ${id} — ${(err as Error).message}`);
        continue;
      }
      try {
        repository.markEmailed(offer.site, offer.external_id, messageId);
      } catch (err) {
        throw new Error(`${id} was sent but could not be recorded, so it may be sent again: ${(err as Error).message}`);
      }
      sent += 1;
      log(`Sent to OFFERS_TO: ${offer.title} (${id}), ${documents.attachments.length} document(s) attached`);
    }
  } finally {
    mailer.close();
    releaseLock();
  }
  return { sent, refused };
}

/**
 * The offer's documents for its email. Never throws: if they cannot be
 * downloaded at all (no downloader, browser that does not start), the offer is
 * sent with the documents listed, and the next offers are not held back.
 */
export async function documentsOf(links: DocumentLink[], download: DocumentsDownloader | undefined): Promise<EmailDocuments> {
  if (links.length === 0) return { attachments: [], notAttached: [] };
  const listed = (reason: string) => ({ attachments: [], notAttached: links.map(({ name }) => ({ name, reason })) });
  if (!download) return listed('non téléchargé, à télécharger sur l’offre en ligne');
  try {
    return await download(links);
  } catch (err) {
    return listed(`téléchargement impossible (${err instanceof Error ? err.message : String(err)}), à télécharger sur l’offre en ligne`);
  }
}

/** One sending run at a time (command and scheduled runs): two would send the same offers. */
function acquireLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'ao-send.lock');
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    throw new Error(`Another ao:send is running. If none is (a previous run crashed), delete ${path}.`);
  }
  closeSync(fd);
  return () => rmSync(path, { force: true });
}
