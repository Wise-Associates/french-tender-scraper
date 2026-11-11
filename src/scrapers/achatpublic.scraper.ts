import { Injectable } from '@nestjs/common';
import { Page } from 'playwright';
import { BaseScraper } from './base.scraper';
import { ScrapeFilters, Tender } from './tender.types';

/**
 * achatpublic.com — "salle des marchés" (SDM).
 * https://www.achatpublic.com/sdm/ent/gen/index.do
 * Enterprise account (Identifiant + password) required. Note: this platform
 * also issues client certificates for bid submission — only reading/browsing
 * is automated here, never bid submission.
 */
@Injectable()
export class AchatpublicScraper extends BaseScraper {
  readonly site = 'achatpublic' as const;
  readonly displayName = 'achatpublic.com (salle des marchés)';
  readonly baseUrl = 'https://www.achatpublic.com';

  protected async login(page: Page): Promise<void> {
    const { username, password } = this.credentials('ACHATPUBLIC');

    await this.gotoWithRetry(page, `${this.baseUrl}/sdm/ent/gen/index.do`);
    await this.dumpDebug(page, 'login');

    // The login form is on the portal home; if not, follow the "Se connecter" link.
    if ((await page.locator('form input[type="password"]:visible').count()) === 0) {
      await page.locator('a:has-text("Se connecter"), a:has-text("Connexion")').first().click();
      await this.humanDelay();
    }

    await page
      .locator('input[name="username"], input[name="login"], input[id*="identifiant" i]')
      .first()
      .fill(username);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('input[type="submit"], button[type="submit"]').first().click();
    await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => undefined);
    await this.dumpDebug(page, 'after-login');
  }

  async scrape(filters: ScrapeFilters): Promise<Tender[]> {
    return this.withPage(async (page) => {
      const searchUrl =
        this.config.get<string>('ACHATPUBLIC_SEARCH_URL') ||
        `${this.baseUrl}/sdm/ent/gen/ent_listeannonce.do`;
      await this.gotoWithRetry(page, searchUrl);
      await this.humanDelay();
      await this.applyKeywords(page, filters.keywords);

      return this.extractListings(page, {
        cardLinkSelectors: ['a[href*="annonce"], a[href*="consultation"]'],
        rowSelectors: [
          this.config.get<string>('ACHATPUBLIC_ROW_SELECTOR') ?? '',
          'table.resultats tbody tr',
          'table.listeAnnonces tbody tr',
          'form table tbody tr',
          'table tbody tr',
        ].filter(Boolean),
        max: filters.maxResults ?? 100,
      });
    });
  }
}
