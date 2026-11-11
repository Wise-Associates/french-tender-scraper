import { Inject, Injectable, Logger } from '@nestjs/common';
import { TendersService } from '../tenders/tenders.service';
import { BaseScraper } from './base.scraper';
import { ScrapeFilters, ScrapeResult, SiteKey, Tender } from './tender.types';

@Injectable()
export class ScrapingService {
  private readonly logger = new Logger(ScrapingService.name);
  private readonly lastResults: ScrapeResult[] = [];

  constructor(
    @Inject('SCRAPERS') private readonly scrapers: BaseScraper[],
    private readonly tendersService: TendersService,
  ) {}

  listScrapers(): { site: SiteKey; name: string; enabled: boolean }[] {
    return this.scrapers.map((s) => ({ site: s.site, name: s.displayName, enabled: s.isEnabled() }));
  }

  getLastResults(): ScrapeResult[] {
    return this.lastResults;
  }

  async run(sites?: SiteKey[], filters: ScrapeFilters = {}): Promise<ScrapeResult[]> {
    const targets = this.scrapers.filter(
      (s) => s.isEnabled() && (!sites?.length || sites.includes(s.site)),
    );
    if (targets.length === 0) {
      throw new Error('No scraper matched the requested sites (or all are disabled).');
    }

    const results: ScrapeResult[] = [];
    for (const scraper of targets) {
      const started = Date.now();
      try {
        this.logger.log(`Scraping ${scraper.displayName}…`);
        const tenders: Tender[] = await scraper.scrape(filters);
        const { newCount } = await this.tendersService.ingest(tenders);
        const result: ScrapeResult = {
          site: scraper.site,
          scrapedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          count: tenders.length,
          newCount,
        };
        results.push(result);
        this.logger.log(
          `${scraper.displayName}: ${tenders.length} tenders (${newCount} new) in ${result.durationMs}ms`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`${scraper.displayName} failed: ${message}`);
        results.push({
          site: scraper.site,
          scrapedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          count: 0,
          newCount: 0,
          error: message,
        });
      }
      // Politeness gap between platforms.
      await new Promise((r) => setTimeout(r, 5_000));
    }

    this.lastResults.unshift(...results);
    this.lastResults.splice(50);
    return results;
  }
}
