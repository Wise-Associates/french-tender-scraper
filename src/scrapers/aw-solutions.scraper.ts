import { Injectable } from '@nestjs/common';
import { Page } from 'playwright';
import { BaseScraper } from './base.scraper';
import { ScrapeFilters, Tender } from './tender.types';

/**
 * AW Solutions — profil acheteur (Avenue-Web Systèmes, groupe Ach@t Solutions).
 * https://www.marches-publics.info (CFML application, /avis/index.cfm routes)
 * Enterprise account needed for search / DCE downloads. The "avis en cours"
 * list is reachable from the portal home after login.
 */
@Injectable()
export class AwSolutionsScraper extends BaseScraper {
  readonly site = 'aw-solutions' as const;
  readonly displayName = 'AW Solutions (marches-publics.info)';
  readonly baseUrl = 'https://www.marches-publics.info';

  protected async login(page: Page): Promise<void> {
    const { username, password } = this.credentials('AWSOLUTIONS');

    await this.gotoWithRetry(
      page,
      `${this.baseUrl}/avis/index.cfm?fuseaction=ent.login&type=Restreint`,
    );
    await this.dumpDebug(page, 'login');

    await page
      .locator('input[name="login"], input[name="identifiant"], input[name="username"]')
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
        this.config.get<string>('AWSOLUTIONS_SEARCH_URL') || `${this.baseUrl}/avis/`;
      await this.gotoWithRetry(page, searchUrl);
      await this.humanDelay();
      await this.applyKeywords(page, filters.keywords);

      return this.extractListings(page, {
        cardLinkSelectors: ['a[href*="index.cfm"]'],
        linkPattern: /(avis|consultation|IDM=|idm=)/,
        rowSelectors: [
          this.config.get<string>('AWSOLUTIONS_ROW_SELECTOR') ?? '',
          'table.resultat tbody tr',
          'table.liste tbody tr',
          'table tbody tr',
        ].filter(Boolean),
        max: filters.maxResults ?? 100,
      });
    });
  }
}
