import { Injectable } from '@nestjs/common';
import { BaseScraper } from './base.scraper';
import { ScrapeFilters, Tender } from './tender.types';

/**
 * Bpifrance — "Appels d'offres".
 * https://www.bpifrance.fr/appels-offres
 * Fully public page listing current tenders with publication/deadline dates.
 */
@Injectable()
export class BpifranceScraper extends BaseScraper {
  readonly site = 'bpifrance' as const;
  readonly displayName = 'Bpifrance (bpifrance.fr/appels-offres)';
  readonly baseUrl = 'https://www.bpifrance.fr';

  protected requiresLogin = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async login(): Promise<void> {
    /* no-op — public page */
  }

  async scrape(filters: ScrapeFilters): Promise<Tender[]> {
    return this.withPage(async (page) => {
      await this.gotoWithRetry(page, `${this.baseUrl}/appels-offres`);
      await this.humanDelay();

      const tenders = await this.extractListings(page, {
        cardLinkSelectors: ['a[href*="/appels-offres/"]'],
        linkPattern: /\/appels-offres\/.+/,
        rowSelectors: [],
        max: filters.maxResults ?? 50,
      });

      // Normalise: the buyer is always Bpifrance on this page.
      return tenders.map((t) => ({
        ...t,
        buyer: 'Bpifrance',
        title: t.title.replace(/^Appel d['’]offres\s*[–-]\s*/i, '').trim() || t.title,
      }));
    });
  }
}
