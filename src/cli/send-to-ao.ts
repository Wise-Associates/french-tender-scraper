/**
 * Emails relevant Partenaire GC offers (Claude analysis) to MyBestConsultant's
 * AO inbox, one offer per email, most urgent deadline first.
 *
 * Usage (after `npm run build`):
 *   npm run ao:send -- --limit 1 --dry-run   # prints the email, sends nothing
 *   npm run ao:send -- --limit 1             # sends one offer to OFFERS_TO
 *
 * A command rather than an API route: the API has no authentication, and
 * anyone reaching it could flood the AO inbox. Delivery is "at least once": an
 * offer is recorded after the SMTP server accepted it, so a crash in between
 * re-sends it next time (MyBestConsultant merges the duplicate).
 */
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { AoMailer, isMessageRejection, parseMailConfig } from '../ao-mail/ao-mailer';
import { renderOfferEmail } from '../ao-mail/offer-email';
import { TendersRepository } from '../tenders/tenders.repository';

const SITE = 'partenaire-gc';

function parseArgs(argv: string[]): { limit: number; dryRun: boolean } {
  const usage = 'Usage: npm run ao:send -- --limit <1-50> [--dry-run]';
  let limit: number | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--limit') limit = Number(argv[++i]);
    else throw new Error(`Unknown argument "${argv[i]}". ${usage}`);
  }
  // Explicit and bounded: a missing --limit must not send every relevant offer at once.
  if (limit === undefined || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error(usage);
  return { limit, dryRun };
}

/** One sending run at a time: two runs would pick and send the same offers. */
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

async function main(): Promise<void> {
  const { limit, dryRun } = parseArgs(process.argv.slice(2));
  if (existsSync('.env')) process.loadEnvFile('.env');

  const repository = new TendersRepository({ get: (key: string) => process.env[key] } as ConfigService);
  try {
    const offers = repository.relevantNotEmailed(SITE, new Date().toISOString(), limit);
    if (offers.length === 0) {
      console.log(
        'No relevant offer left to send: run a scrape with ANTHROPIC_API_KEY set first ' +
          '(offers already sent or past their deadline are skipped).',
      );
      return;
    }

    if (dryRun) {
      for (const offer of offers) {
        const email = renderOfferEmail(offer);
        console.log(`\n=== ${email.subject}\n\n${email.text}`);
      }
      console.log(`\nDry run: ${offers.length} offer(s) shown, nothing sent.`);
      return;
    }

    const releaseLock = acquireLock(process.env.DATA_DIR || './data');
    const mailer = new AoMailer(parseMailConfig(process.env));
    let refused = 0;
    try {
      // Selected again under the lock: another run may have sent some meanwhile.
      for (const offer of repository.relevantNotEmailed(SITE, new Date().toISOString(), limit)) {
        const id = `${offer.site}:${offer.external_id}`;
        let messageId: string;
        try {
          ({ messageId } = await mailer.sendOffer(renderOfferEmail(offer)));
        } catch (err) {
          // A message refused for its content must not block the next offers.
          if (!isMessageRejection(err)) throw err;
          refused += 1;
          console.error(`Refused by the SMTP server, retried next time: ${id} — ${(err as Error).message}`);
          continue;
        }
        try {
          repository.markEmailed(offer.site, offer.external_id, messageId);
        } catch (err) {
          throw new Error(`${id} was sent but could not be recorded, so it may be sent again: ${(err as Error).message}`);
        }
        console.log(`Sent to OFFERS_TO: ${offer.title} (${id})`);
      }
    } finally {
      mailer.close();
      releaseLock();
    }
    if (refused > 0) process.exitCode = 1;
  } finally {
    repository.onModuleDestroy();
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});
