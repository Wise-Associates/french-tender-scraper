import { closeSync, mkdirSync, openSync, rmSync } from 'fs';
import { join } from 'path';
import { TendersRepository } from '../tenders/tenders.repository';
import { AoMailer, isMessageRejection, MailConfig } from './ao-mailer';
import { renderOfferEmail } from './offer-email';

/** Most offers emailed in one go (`ao:send` or after a scrape). */
export const MAX_EMAILS_PER_SEND = 50;

/**
 * Emails the relevant offers of `site` not sent yet to the AO inbox, most
 * urgent deadline first. Used by `npm run ao:send` and after each scrape.
 * An offer is recorded once the SMTP server accepted it; a message refused
 * for its content is skipped (retried next time); any other error stops.
 */
export async function sendRelevantOffers(
  repository: TendersRepository,
  config: MailConfig,
  site: string,
  limit: number,
  dataDir: string,
  log: (message: string) => void,
): Promise<{ sent: number; refused: number }> {
  const releaseLock = acquireLock(dataDir);
  const mailer = new AoMailer(config);
  let sent = 0;
  let refused = 0;
  try {
    // Selected under the lock: another run may have sent some meanwhile.
    for (const offer of repository.relevantNotEmailed(site, new Date().toISOString(), limit)) {
      const id = `${offer.site}:${offer.external_id}`;
      let messageId: string;
      try {
        ({ messageId } = await mailer.sendOffer(renderOfferEmail(offer)));
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
      log(`Sent to OFFERS_TO: ${offer.title} (${id})`);
    }
  } finally {
    mailer.close();
    releaseLock();
  }
  return { sent, refused };
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
