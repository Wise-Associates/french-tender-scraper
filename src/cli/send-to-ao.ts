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
import { existsSync } from 'fs';
import { ConfigService } from '@nestjs/config';
import { parseMailConfig } from '../ao-mail/ao-mailer';
import { renderOfferEmail } from '../ao-mail/offer-email';
import { MAX_EMAILS_PER_SEND, sendRelevantOffers } from '../ao-mail/send-offers';
import { BrowserService } from '../scrapers/browser.service';
import { PartenaireGcScraper } from '../scrapers/partenaire-gc.scraper';
import { TendersRepository } from '../tenders/tenders.repository';

const SITE = 'partenaire-gc';

function parseArgs(argv: string[]): { limit: number; dryRun: boolean } {
  const usage = `Usage: npm run ao:send -- --limit <1-${MAX_EMAILS_PER_SEND}> [--dry-run]`;
  let limit: number | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--limit') limit = Number(argv[++i]);
    else throw new Error(`Unknown argument "${argv[i]}". ${usage}`);
  }
  // Explicit and bounded: a missing --limit must not send every relevant offer at once.
  if (limit === undefined || !Number.isInteger(limit) || limit < 1 || limit > MAX_EMAILS_PER_SEND) throw new Error(usage);
  return { limit, dryRun };
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
        const documents = repository.documentLinks(offer.site, offer.external_id).map((d) => d.name);
        console.log(`\n=== ${email.subject}\n\n${email.text}`);
        if (documents.length) console.log(`\nDocuments (downloaded and attached when sent): ${documents.join(', ')}`);
      }
      console.log(`\nDry run: ${offers.length} offer(s) shown, nothing sent or downloaded.`);
      return;
    }

    // The documents are downloaded with the saved session, through the API's own browser code (same session
    // file and user agent), without starting the API and its scheduler. Chromium starts only if an offer has documents.
    const config = { get: (key: string) => process.env[key] } as ConfigService;
    const browser = new BrowserService(config);
    const scraper = new PartenaireGcScraper(browser, config);
    try {
      const { refused } = await sendRelevantOffers(
        repository,
        parseMailConfig(process.env),
        SITE,
        limit,
        process.env.DATA_DIR || './data',
        (message) => console.log(message),
        (links) => scraper.documentsForEmail(links),
      );
      if (refused > 0) process.exitCode = 1;
    } finally {
      await browser.onModuleDestroy();
    }
  } finally {
    repository.onModuleDestroy();
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});
