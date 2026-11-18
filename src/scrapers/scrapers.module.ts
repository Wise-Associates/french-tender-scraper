import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { TendersModule } from '../tenders/tenders.module';
import { BrowserService } from './browser.service';
import { BaseScraper } from './base.scraper';
import { MaximilienScraper } from './maximilien.scraper';
import { AwSolutionsScraper } from './aw-solutions.scraper';
import { AchatpublicScraper } from './achatpublic.scraper';
import { EMarchespublicsScraper } from './emarchespublics.scraper';
import { BpifranceScraper } from './bpifrance.scraper';
import { PartenaireGcScraper } from './partenaire-gc.scraper';
import { ScrapingService } from './scraping.service';
import { ScraperScheduler } from './scraper.scheduler';
import { ScrapeController } from './scrape.controller';

const SCRAPER_PROVIDERS = [
  MaximilienScraper,
  AwSolutionsScraper,
  AchatpublicScraper,
  EMarchespublicsScraper,
  BpifranceScraper,
  PartenaireGcScraper,
];

@Module({
  imports: [TendersModule, AnalysisModule, AlertsModule],
  controllers: [ScrapeController],
  providers: [
    BrowserService,
    ...SCRAPER_PROVIDERS,
    {
      provide: 'SCRAPERS',
      useFactory: (...scrapers: BaseScraper[]) => scrapers,
      inject: SCRAPER_PROVIDERS,
    },
    ScrapingService,
    ScraperScheduler,
  ],
})
export class ScrapersModule {}
