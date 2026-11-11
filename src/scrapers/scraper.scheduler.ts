import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ScrapingService } from './scraping.service';

@Injectable()
export class ScraperScheduler implements OnModuleInit {
  private readonly logger = new Logger(ScraperScheduler.name);

  constructor(
    private readonly config: ConfigService,
    private readonly scraping: ScrapingService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const minutes = Number(this.config.get<string>('SCRAPE_INTERVAL_MINUTES') ?? 360);
    if (!minutes || minutes <= 0) {
      this.logger.log('Automatic scraping disabled (SCRAPE_INTERVAL_MINUTES=0)');
      return;
    }
    const interval = setInterval(() => {
      this.scraping.run().catch((err) => this.logger.error(`Scheduled run failed: ${err.message}`));
    }, minutes * 60_000);
    this.schedulerRegistry.addInterval('scrape-all', interval);
    this.logger.log(`Scheduled scraping every ${minutes} minutes`);
  }
}
