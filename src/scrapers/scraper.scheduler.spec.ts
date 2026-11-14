import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ScraperScheduler } from './scraper.scheduler';
import { ScrapingService } from './scraping.service';

function setup(cron: string | undefined) {
  const jobs: CronJob[] = [];
  const registry = { addCronJob: (_name: string, job: CronJob) => jobs.push(job) } as unknown as SchedulerRegistry;
  const config = { get: (key: string) => (key === 'SCRAPE_CRON' ? cron : undefined) } as ConfigService;
  const scheduler = new ScraperScheduler(config, {} as ScrapingService, registry);
  return { scheduler, jobs };
}

describe('ScraperScheduler', () => {
  it('schedules runs at fixed Paris times', () => {
    const { scheduler, jobs } = setup('0 8,12,16,20 * * *');
    scheduler.onModuleInit();
    try {
      assert.equal(jobs.length, 1);
      const next = jobs[0].nextDate().setZone('Europe/Paris');
      assert.ok([8, 12, 16, 20].includes(next.hour) && next.minute === 0, next.toISO() ?? '');
    } finally {
      jobs.forEach((job) => job.stop());
    }
  });

  it('schedules nothing when SCRAPE_CRON is empty or unset', () => {
    for (const value of [undefined, '', '  ']) {
      const { scheduler, jobs } = setup(value);
      scheduler.onModuleInit();
      assert.equal(jobs.length, 0);
    }
  });

  it('refuses to start with an invalid expression', () => {
    assert.throws(() => setup('every morning').scheduler.onModuleInit(), /SCRAPE_CRON "every morning" is not a valid cron expression/);
  });
});
