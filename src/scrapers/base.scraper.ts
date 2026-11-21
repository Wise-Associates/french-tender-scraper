import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Page, Response } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { DocumentLink } from '../documents/offer-documents';
import { EmailDocuments } from '../documents/read-documents';
import { BrowserService } from './browser.service';
import { OfferDetails, ScrapeFilters, SiteKey, Tender } from './tender.types';

export interface ExtractOptions {
  /** Candidate CSS selectors for result rows (table mode). First match wins. */
  rowSelectors: string[];
  /** Candidate CSS selectors for card links (card mode). First match wins. */
  cardLinkSelectors: string[];
  /** Only keep card links whose href matches this pattern (e.g. /detail|\/avis\/). */
  linkPattern?: RegExp;
  max: number;
}

/**
 * The site's saved session is missing or expired and only a manual login
 * (`npm run login:session -- <site>`) fixes it. Stops the site's run and
 * emails the operator (ScrapingService, ADR 0005).
 */
export class SessionMissingError extends Error {}

/** Statuses where the same request may succeed a few seconds later. */
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function describeHttpFailure(status: number, statusText: string, url: string): string {
  const head = `HTTP ${status}${statusText ? ` ${statusText}` : ''} from ${url}`;
  if (status === 401 || status === 403) {
    return (
      `${head}: the site refused access (typically bot protection, a country restriction ` +
      'or an expired login session). This is not a selector problem.'
    );
  }
  if (status === 429) return `${head}: the site is rate-limiting requests; lower the scraping frequency.`;
  return head;
}

/**
 * Base class for all site scrapers.
 *
 * Handles: session reuse, login-once semantics, human-like delays, retries,
 * debug HTML dumps (DEBUG_SCRAPER=1) and two generic extraction strategies
 * (table rows / card lists) with configurable CSS selectors — because these
 * platforms revamp their HTML regularly, selectors live in env vars so they
 * can be recalibrated without touching code.
 *
 * @Injectable() is required even though this class is abstract: subclasses
 * inherit this constructor, and TypeScript only emits the constructor's
 * parameter types (which Nest uses for injection) on a decorated class.
 * Without it every scraper is built with `browser` and `config` undefined.
 */
@Injectable()
export abstract class BaseScraper {
  abstract readonly site: SiteKey;
  abstract readonly displayName: string;
  abstract readonly baseUrl: string;
  /**
   * The login is done by hand (`npm run login:session`) and expires: the
   * session state is reported to MyBestConsultant after each run (ADR 0006).
   */
  readonly manualSession: boolean = false;

  /** Set false for sites/areas that are publicly accessible. */
  protected requiresLogin = true;

  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly browser: BrowserService,
    protected readonly config: ConfigService,
  ) {}

  /** One-shot login flow for this site. Only invoked when no valid session exists. */
  protected abstract login(page: Page): Promise<void>;

  abstract scrape(filters: ScrapeFilters): Promise<Tender[]>;

  /** Implemented by sites whose detail pages are analysed by Claude (see OfferAnalysisService). */
  fetchDetails?(tenders: Tender[]): Promise<OfferDetails[]>;

  /** Implemented by sites whose offers have documents: downloads them for the AO inbox email (ADR 0007). */
  documentsForEmail?(links: DocumentLink[]): Promise<EmailDocuments>;

  isEnabled(): boolean {
    const key = this.site.replace(/-/g, '').toUpperCase();
    return this.config.get<string>(`${key}_ENABLED`) !== 'false';
  }

  // ---------------------------------------------------------------- session

  protected async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const context = await this.browser.context(this.site);
    const page = await context.newPage();
    try {
      if (this.requiresLogin) {
        await this.gotoWithRetry(page, this.baseUrl);
        if (await this.needsLogin(page)) {
          this.logger.warn(`No valid session for ${this.displayName} — running login flow`);
          await this.login(page);
          await this.browser.persistSession(this.site, context);
        } else {
          this.logger.log(`Reused existing session for ${this.displayName}`);
        }
      }
      return await fn(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  protected async needsLogin(page: Page): Promise<boolean> {
    // Generic heuristic: a visible password field means "not logged in yet".
    return (await page.locator('form input[type="password"]:visible').count()) > 0;
  }

  protected credentials(prefix: string): { username: string; password: string } {
    const username = this.config.get<string>(`${prefix}_USERNAME`) ?? '';
    const password = this.config.get<string>(`${prefix}_PASSWORD`) ?? '';
    if (!username || !password) {
      throw new Error(
        `Credentials missing: set ${prefix}_USERNAME and ${prefix}_PASSWORD in .env`,
      );
    }
    return { username, password };
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Navigates to `url`, retrying network errors and transient HTTP statuses.
   * Any other HTTP error fails immediately: otherwise the error page would be
   * parsed as a listing and reported as a selector problem, and re-requesting
   * a page the site refuses (e.g. a bot-protection 403) is pointless.
   */
  protected async gotoWithRetry(page: Page, url: string, retries = 3): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      let response: Response | null;
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch (err) {
        if (attempt >= retries) throw err;
        this.logger.warn(`goto failed (attempt ${attempt}/${retries}) — retrying…`);
        await this.humanDelay(2_000 * attempt);
        continue;
      }

      // null means the navigation had no network response (same-document): nothing to check.
      if (!response || response.ok()) return;

      const status = response.status();
      if (!RETRYABLE_HTTP_STATUSES.has(status) || attempt >= retries) {
        throw new Error(describeHttpFailure(status, response.statusText(), url));
      }
      this.logger.warn(`HTTP ${status} from ${url} (attempt ${attempt}/${retries}) — retrying…`);
      await this.humanDelay(2_000 * attempt);
    }
  }

  protected async humanDelay(ms?: number): Promise<void> {
    const base = ms ?? Number(this.config.get<string>('SCRAPE_MIN_DELAY_MS') ?? 1_200);
    await new Promise((resolve) => setTimeout(resolve, base + Math.random() * base));
  }

  /** Best-effort keyword search: fills the first visible search input and submits. */
  protected async applyKeywords(page: Page, keywords?: string[]): Promise<void> {
    if (!keywords?.length) return;
    const input = page.locator(
      'input[type="search"]:visible, input[name*="search" i]:visible, input[name*="recherche" i]:visible, input[name*="motcle" i]:visible',
    );
    if ((await input.count()) === 0) {
      this.logger.warn('No search input found — keyword filter not applied');
      return;
    }
    await input.first().fill(keywords.join(' '));
    await this.humanDelay();
    const form = input.first().locator('xpath=ancestor::form[1]');
    if ((await form.count()) > 0) await form.first().press('Enter');
    else await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
  }

  protected async dumpDebug(page: Page, name: string): Promise<void> {
    if (this.config.get<string>('DEBUG_SCRAPER') !== '1') return;
    const dir = './debug';
    // Owner-only: dumps of logged-in areas contain paid content and account details.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${this.site}-${name}-${Date.now()}.html`);
    writeFileSync(file, await page.content(), { encoding: 'utf-8', mode: 0o600 });
    this.logger.log(`Debug HTML saved: ${file}`);
  }

  // ----------------------------------------------------------- extraction

  /**
   * Generic listing extraction. Tries "card" mode (anchor-based, for modern
   * sites like bpifrance.fr / e-marchespublics.com) then "table" mode (for the
   * legacy CFML/Java platforms like AW Solutions and achatpublic).
   */
  protected async extractListings(page: Page, opts: ExtractOptions): Promise<Tender[]> {
    await this.dumpDebug(page, 'listing');

    // --- Card mode -------------------------------------------------------
    for (const selector of opts.cardLinkSelectors) {
      const anchors = page.locator(selector);
      if ((await anchors.count()) === 0) continue;
      const cards = await page.evaluate(
        ({ sel, pattern }) => {
          const re = pattern ? new RegExp(pattern, 'i') : null;
          return [...document.querySelectorAll<HTMLAnchorElement>(sel)]
            .filter((a) => (re ? re.test(a.getAttribute('href') ?? '') : true))
            .slice(0, 100)
            .map((a) => {
              const container = a.closest('article, li, tr, [class*="card" i], [class*="result" i]') ?? a.parentElement;
              return {
                title: (a.textContent ?? '').replace(/\s+/g, ' ').trim(),
                href: a.getAttribute('href') ?? '',
                context: (container?.textContent ?? '').replace(/\s+/g, ' ').trim(),
              };
            });
        },
        { sel: selector, pattern: opts.linkPattern?.source },
      );
      if (cards.length > 0) return cards.slice(0, opts.max).map((c, i) => this.toTender(c, i));
    }

    // --- Table mode ------------------------------------------------------
    for (const selector of opts.rowSelectors) {
      const rows = page.locator(selector);
      if ((await rows.count()) === 0) continue;
      const tenders: Tender[] = [];
      const rowCount = Math.min(await rows.count(), opts.max);
      for (let i = 0; i < rowCount; i += 1) {
        const row = rows.nth(i);
        const cells = (await row.locator('td').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
        const link = row.locator('a').first();
        const href = (await link.getAttribute('href').catch(() => null)) ?? '';
        const linkText = (await link.textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim() ?? '';
        const title = linkText.length > 10 ? linkText : cells.find((c) => c.length > 15) ?? '';
        if (!title) continue;
        tenders.push(
          this.toTender(
            { title, href, context: cells.join(' | ') },
            i,
            { buyer: cells[0] },
          ),
        );
      }
      if (tenders.length > 0) return tenders;
    }

    throw new Error(
      `No listings matched any known selector for ${this.displayName}. ` +
        'Set DEBUG_SCRAPER=1, open ./debug/*.html and recalibrate selectors via env vars.',
    );
  }

  protected toTender(
    card: { title: string; href: string; context: string },
    index: number,
    extra: Partial<Tender> = {},
  ): Tender {
    const url = card.href ? new URL(card.href, this.baseUrl).toString() : this.baseUrl;
    return {
      site: this.site,
      externalId: this.extractExternalId(card.href, card.title, index),
      title: card.title,
      url,
      publishedAt: this.parseFrenchDate(this.findDate(card.context)),
      deadlineAt: this.parseFrenchDate(this.findDate(card.context, /(\d{2}\/\d{2}\/\d{4}(?:\s+[à]?\s*\d{2}h\d{2})?)/g, 1)),
      description: card.context.slice(0, 1_000),
      raw: { context: card.context },
      ...extra,
    };
  }

  protected extractExternalId(href: string, title: string, index: number): string {
    const m =
      href.match(/(?:id|idm|reference|ref|numero|dossier)[=/]([\w.-]+)/i) ??
      href.match(/(\d{4,})[./]?(?:\.cfm|\.do|\.htm|\/|$)/);
    if (m) return m[1];
    return `hash-${createHash('sha1').update(title).digest('hex').slice(0, 12)}-${index}`;
  }

  protected findDate(text: string, re = /(\d{2}\/\d{2}\/\d{4})/g, occurrence = 0): string | undefined {
    const matches = [...text.matchAll(re)].map((x) => x[1]);
    return matches[occurrence] ?? matches[0];
  }

  /** Accepts DD/MM/YYYY or DD/MM/YYYY HHhMM, returns ISO string. */
  protected parseFrenchDate(value?: string): string | undefined {
    if (!value) return undefined;
    const m = value.match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s*(?:à)?\s*(\d{2})h(\d{2}))?/);
    if (!m) return undefined;
    const [, dd, mm, yyyy, hh, min] = m;
    const iso = `${yyyy}-${mm}-${dd}T${hh ?? '00'}:${min ?? '00'}:00+01:00`;
    return Number.isNaN(Date.parse(iso)) ? undefined : iso;
  }
}
