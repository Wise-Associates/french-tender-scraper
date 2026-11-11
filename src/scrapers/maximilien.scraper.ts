import { Injectable } from '@nestjs/common';
import { Page } from 'playwright';
import { BaseScraper } from './base.scraper';
import { ScrapeFilters, Tender } from './tender.types';

/**
 * Maximilien — plateforme de la commande publique en Île-de-France.
 * https://marches.maximilien.fr (SSO: https://socle.maximilien.fr)
 * Free enterprise account (SIRET). Login required for the search area.
 */
@Injectable()
export class MaximilienScraper extends BaseScraper {
  readonly site = 'maximilien' as const;
  readonly displayName = 'Maximilien (marches.maximilien.fr)';
  readonly baseUrl = 'https://marches.maximilien.fr';

  protected async login(page: Page): Promise<void> {
    const { username, password } = this.credentials('MAXIMILIEN');

    // The platform delegates authentication to the "socle" SSO.
    await this.gotoWithRetry(page, 'https://socle.maximilien.fr/user/login');
    await this.dumpDebug(page, 'login');

    await page
      .locator('input[name="login"], input[name="username"], input[name="identifiant"], input[type="email"]')
      .first()
      .fill(username);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => undefined);
    await this.dumpDebug(page, 'after-login');
  }

  async scrape(filters: ScrapeFilters): Promise<Tender[]> {
    return this.withPage(async (page) => {
      // Once logged in, set MAXIMILIEN_SEARCH_URL to the URL of your advanced
      // search ("recherche multicritères") results page. Without it we land on
      // the app home and still try the generic extraction.
      const searchUrl =
        this.config.get<string>('MAXIMILIEN_SEARCH_URL') ||
        `${this.baseUrl}/?page=Entreprise.EntrepriseAdvancedSearch`;
      await this.gotoWithRetry(page, searchUrl);
      await this.humanDelay();
      await this.applyKeywords(page, filters.keywords);

      return this.extractListings(page, {
        cardLinkSelectors: ['a[href*="Detail"], a[href*="detail"]'],
        rowSelectors: [
          this.config.get<string>('MAXIMILIEN_ROW_SELECTOR') ?? '',
          'table.resultats tbody tr',
          'table.liste tbody tr',
          '.resultats tbody tr',
          'table tbody tr',
        ].filter(Boolean),
        max: filters.maxResults ?? 50,
      });
    });
  }
}
