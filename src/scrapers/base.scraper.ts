import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { BrowserService } from './browser.service';
import { ScrapeFilters, SiteKey, Tender } from './tender.types';

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
 * Base class for all site scrapers.
 *
 * Handles: session reuse, login-once semantics, human-like delays, retries,
 * debug HTML dumps (DEBUG_SCRAPER=1) and two generic extraction strategies
 * (table rows / card lists) with configurable CSS selectors — because these
 * platforms revamp their HTML regularly, selectors live in env vars so they
 * can be recalibrated without touching code.
 */
export abstract class BaseScraper {
  abstract readonly site: SiteKey;
  abstract readonly displayName: string;
  abstract readonly baseUrl: string;

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

  protected async gotoWithRetry(page: Page, url: string, retries = 3): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        return;
      } catch (err) {
        if (attempt >= retries) throw err;
        this.logger.warn(`goto failed (attempt ${attempt}/${retries}) — retrying…`);
        await this.humanDelay(2_000 * attempt);
      }
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
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${this.site}-${name}-${Date.now()}.html`);
    writeFileSync(file, await page.content(), 'utf-8');
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
