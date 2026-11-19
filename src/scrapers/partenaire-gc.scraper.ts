import { Injectable } from '@nestjs/common';
import { Page } from 'playwright';
import { BaseScraper, SessionMissingError } from './base.scraper';
import { matchesKeywords, PARTENAIRE_GC_ORIGIN, PartenaireGcRow, toPartenaireGcTender } from './partenaire-gc.listing';
import { OfferDetails, ScrapeFilters, Tender } from './tender.types';

/** The Drupal view rendering "Consultations en cours" (subscriber home and /consultations). */
const LISTING_SELECTOR = '.view-id-affaires';
/** Safety stop if the pager ever loops; the listing had 3 pages in November 2026. */
const MAX_PAGES = 20;
/** The free-text "Contexte et détails de la mission" of a detail page (~2,500 characters). */
const MISSION_TEXT_SELECTOR = '.field--name-field-body-prive';
/** Far above real offers; guards the Claude bill against a malformed page. */
const MAX_MISSION_TEXT_LENGTH = 20_000;

/** The offer's detail page cannot be analysed as it is (counts as a failed attempt). */
class OfferContentError extends Error {}

/**
 * Where the session is checked and how a logged-out page is recognised.
 * Shared with the manual-login command (src/cli/login-session.ts).
 * The selector targets the Drupal login form itself rather than any password
 * field, so a password-change form on the account pages does not read as
 * "logged out".
 */
export const PARTENAIRE_GC_LOGIN = {
  url: `${PARTENAIRE_GC_ORIGIN}/espace-abonne`,
  loginFormSelector: 'form.user-login-form',
};


/**
 * Partenaire GC — paid subscriber area ("espace abonné").
 *
 * The login form is protected by Drupal's Antibot module, which only accepts a
 * submission after real human interaction. We deliberately do not automate it:
 * a person logs in once with `npm run login:session -- partenaire-gc`, which
 * saves the session to SESSIONS_DIR, and this scraper only reuses that session.
 * There are therefore no PARTENAIREGC_USERNAME / _PASSWORD variables.
 */
@Injectable()
export class PartenaireGcScraper extends BaseScraper {
  readonly site = 'partenaire-gc' as const;
  readonly displayName = 'Partenaire GC (espace abonné)';
  readonly manualSession = true;
  // withPage() checks the session on baseUrl: the subscriber area shows the
  // login form when the session is missing or expired.
  readonly baseUrl = PARTENAIRE_GC_LOGIN.url;

  protected async needsLogin(page: Page): Promise<boolean> {
    return (await page.locator(PARTENAIRE_GC_LOGIN.loginFormSelector).count()) > 0;
  }

  protected async login(): Promise<void> {
    await this.failMissingSession();
  }

  /**
   * Reads the "Consultations en cours" listing page by page. Keywords are
   * matched on our side (see matchesKeywords), so with keywords every page is
   * read before keeping up to `maxResults` offers.
   */
  async scrape(filters: ScrapeFilters): Promise<Tender[]> {
    return this.withPage(async (page) => {
      // withPage() already opened baseUrl; PARTENAIREGC_SEARCH_URL can point at
      // another page showing the same listing (e.g. /consultations with filters).
      const searchUrl = this.config.get<string>('PARTENAIREGC_SEARCH_URL') || this.baseUrl;
      if (searchUrl !== this.baseUrl) await this.openPage(page, searchUrl);

      const max = filters.maxResults ?? 50;
      const tenders: Tender[] = [];
      for (let pageNumber = 1; ; pageNumber += 1) {
        await this.dumpDebug(page, `listing-p${pageNumber}`);
        if ((await page.locator(LISTING_SELECTOR).count()) === 0) {
          throw new Error(
            `No "Consultations en cours" listing on ${page.url()} — the page layout may have changed. ` +
              'Set DEBUG_SCRAPER=1 and check ./debug/partenaire-gc-listing-*.html.',
          );
        }

        const rows = await this.readRows(page);
        for (const row of rows) {
          const tender = toPartenaireGcTender(row, page.url());
          if (!matchesKeywords(tender, filters.keywords)) continue;
          tenders.push(tender);
          if (tenders.length >= max) return tenders;
        }

        const nextLink = page.locator(`${LISTING_SELECTOR} a[rel="next"]`).first();
        const next = (await nextLink.count()) > 0 ? await nextLink.getAttribute('href') : null;
        if (!next) return tenders;
        if (pageNumber >= MAX_PAGES) {
          this.logger.warn(`Stopped after ${MAX_PAGES} pages — later offers were not read`);
          return tenders;
        }
        await this.humanDelay();
        await this.openPage(page, new URL(next, page.url()).toString());
      }
    });
  }

  /**
   * Reads the mission description of each offer's detail page, one page at a
   * time with the usual delay. An offer that cannot be read is reported and
   * left for the next run; a missing session stops the whole batch.
   */
  async fetchDetails(tenders: Tender[]): Promise<OfferDetails[]> {
    return this.withPage(async (page) => {
      const details: OfferDetails[] = [];
      for (const tender of tenders) {
        try {
          // Offer URLs come from the listing's links: never follow one off the site.
          if (new URL(tender.url).origin !== PARTENAIRE_GC_ORIGIN) throw new OfferContentError(`URL outside ${PARTENAIRE_GC_ORIGIN}`);
          await this.humanDelay();
          await this.openPage(page, tender.url);
          details.push({ tender, text: await this.readMissionText(page) });
        } catch (err) {
          if (err instanceof SessionMissingError) throw err;
          details.push({
            tender,
            error: err instanceof Error ? err.message : String(err),
            offerProblem: err instanceof OfferContentError,
          });
        }
      }
      return details;
    });
  }

  private async readMissionText(page: Page): Promise<string> {
    const body = page.locator(MISSION_TEXT_SELECTOR).first();
    const text = (await body.count()) > 0 ? (await body.innerText()).trim() : '';
    if (!text) throw new OfferContentError(`No mission description on ${page.url()}`);
    // Not truncated: a partial description could be misclassified.
    if (text.length > MAX_MISSION_TEXT_LENGTH) {
      throw new OfferContentError(`Mission description of ${text.length} characters on ${page.url()} is too long to analyse`);
    }
    return text;
  }

  private async openPage(page: Page, url: string): Promise<void> {
    await this.gotoWithRetry(page, url);
    // The session can expire after the check withPage() made on baseUrl.
    if (await this.needsLogin(page)) await this.failMissingSession();
  }

  /** Offers of the current page; an offer without a title link is skipped with a warning. */
  private async readRows(page: Page): Promise<PartenaireGcRow[]> {
    const rows = await page.$$eval(`${LISTING_SELECTOR} .view-content .views-row`, (elements) =>
      elements.map((el) => {
        const field = (name: string) => el.querySelector(`.views-field-${name}`);
        const text = (name: string) => (field(name)?.textContent ?? '').replace(/\s+/g, ' ').trim();
        const datetime = (name: string) => field(name)?.querySelector('time')?.getAttribute('datetime') ?? '';
        const link = field('field-affaire-profil')?.querySelector('a');
        return {
          href: link?.getAttribute('href') ?? '',
          title: (link?.textContent ?? '').replace(/\s+/g, ' ').trim(),
          enseigne: text('field-affaire-enseigne'),
          filiale: text('field-affaire-filiale'),
          publishedAt: datetime('created'),
          deadlineAt: datetime('field-date-avec-heure'),
          code: text('field-affaire-code'),
          lieu: text('field-affaire-lieu'),
          tarif: text('field-affaire-tarif-journalier'),
          commission: text('field-affaire-taux-rfa'),
          delai: text('field-delai-reglement'),
        };
      }),
    );
    const usable = rows.filter((row) => row.href && row.title);
    if (usable.length < rows.length) {
      this.logger.warn(`${rows.length - usable.length} offer(s) without a title link skipped on ${page.url()}`);
    }
    return usable;
  }

  private async failMissingSession(): Promise<never> {
    // The cached browser context has no valid session: drop it so the next
    // run loads the file written by `login:session` without a server restart.
    await this.browser.discardContext(this.site);
    throw new SessionMissingError(
      'Partenaire GC session missing or expired. Log in yourself with ' +
        '`npm run login:session -- partenaire-gc`, then rerun the scrape.',
    );
  }
}
