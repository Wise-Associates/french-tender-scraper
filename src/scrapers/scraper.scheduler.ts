import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ScrapingService } from './scraping.service';

/** Runs follow Paris clock time, whatever the server's time zone. */
export const SCRAPE_TIME_ZONE = 'Europe/Paris';

/**
 * Scheduled runs at fixed times: SCRAPE_CRON (e.g. '0 8,12,16,20 * * *').
 * Empty or unset: no automatic run (a laptop never scrapes or sends by
 * surprise). A run due while another is still going is skipped
 * (ScrapingService refuses overlapping runs).
 */
@Injectable()
export class ScraperScheduler implements OnModuleInit {
  private readonly logger = new Logger(ScraperScheduler.name);

  constructor(
    private readonly config: ConfigService,
    private readonly scraping: ScrapingService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const expression = this.config.get<string>('SCRAPE_CRON')?.trim();
    if (!expression) {
      this.logger.log('Automatic scraping disabled (SCRAPE_CRON is empty)');
      return;
    }
    let job: CronJob;
    try {
      job = new CronJob(expression, () => {
        this.scraping.run().catch((err) => this.logger.error(`Scheduled run failed: ${err.message}`));
      }, null, false, SCRAPE_TIME_ZONE);
    } catch (err) {
      // Fails the startup: on the VPS the deployment then puts the previous version back.
      throw new Error(`SCRAPE_CRON "${expression}" is not a valid cron expression: ${(err as Error).message}`);
    }
    this.schedulerRegistry.addCronJob('scrape-all', job);
    job.start();
    this.logger.log(`Scheduled scraping "${expression}" (${SCRAPE_TIME_ZONE}), next run ${job.nextDate().toISO()}`);
  }
}
