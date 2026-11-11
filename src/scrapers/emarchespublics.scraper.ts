import { Injectable } from '@nestjs/common';
import { BaseScraper } from './base.scraper';
import { ScrapeFilters, Tender } from './tender.types';

/**
 * e-marchespublics.com — veille et dématérialisation (groupe Les Echos).
 * https://www.e-marchespublics.com
 * The homepage exposes "Les derniers appels d'offres" publicly; the
 * multi-criteria search and DCE downloads sit behind a free enterprise
 * account. This scraper targets the public listing (no login required).
 */
@Injectable()
export class EMarchespublicsScraper extends BaseScraper {
  readonly site = 'emarchespublics' as const;
  readonly displayName = 'e-marchespublics.com';
  readonly baseUrl = 'https://www.e-marchespublics.com';

  // Public listing: no authentication needed.
  protected requiresLogin = false;

  // Kept for a future logged-in "my alerts" mode.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async login(): Promise<void> {
    /* no-op */
  }

  async scrape(filters: ScrapeFilters): Promise<Tender[]> {
    return this.withPage(async (page) => {
      await this.gotoWithRetry(page, this.baseUrl);
      await this.humanDelay();

      return this.extractListings(page, {
        cardLinkSelectors: [
          'a[href*="/appels-offres/"]',
          'a[href*="/appel-offres/"]',
          'a[href*="/consultation"]',
        ],
        // Keep only detail links (skip navigation/category links).
        linkPattern: /\/(appels?-offres?|consultation)\//,
        rowSelectors: [],
        max: filters.maxResults ?? 30,
      });
    });
  }
}
