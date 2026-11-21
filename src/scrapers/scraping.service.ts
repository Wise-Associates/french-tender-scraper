import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  CLAUDE_CREDITS_ALERT,
  claudeCreditsAlert,
  MBC_STATUS_ALERT,
  mbcStatusAlert,
  sessionAlertKind,
  sessionExpiredAlert,
} from '../alerts/operator-alerts';
import { MbcStatusReporter, SessionState } from '../alerts/mbc-status';
import { OperatorAlertsService } from '../alerts/operator-alerts.service';
import { OfferAnalysisService } from '../analysis/offer-analysis.service';
import { parseMailConfig } from '../ao-mail/ao-mailer';
import { MAX_EMAILS_PER_SEND, sendRelevantOffers } from '../ao-mail/send-offers';
import { TendersRepository } from '../tenders/tenders.repository';
import { TendersService } from '../tenders/tenders.service';
import { BaseScraper, SessionMissingError } from './base.scraper';
import { AnalysisSummary, ScrapeFilters, ScrapeResult, SiteKey, Tender } from './tender.types';

@Injectable()
export class ScrapingService {
  private readonly logger = new Logger(ScrapingService.name);
  private readonly lastResults: ScrapeResult[] = [];
  private running = false;

  constructor(
    @Inject('SCRAPERS') private readonly scrapers: BaseScraper[],
    private readonly tendersService: TendersService,
    private readonly offerAnalysis: OfferAnalysisService,
    private readonly repository: TendersRepository,
    private readonly alerts: OperatorAlertsService,
    private readonly mbcStatus: MbcStatusReporter,
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
    // One run at a time (scheduler + API): parallel runs share the per-site
    // browser contexts — one run discarding an expired-session context would
    // close it under the other — and would hit the sites twice.
    if (this.running) {
      throw new ConflictException('A scraping run is already in progress — retry when it has finished.');
    }
    this.running = true;
    try {
      return await this.runTargets(targets, filters);
    } finally {
      this.running = false;
    }
  }

  private async runTargets(targets: BaseScraper[], filters: ScrapeFilters): Promise<ScrapeResult[]> {
    const results: ScrapeResult[] = [];
    for (const scraper of targets) {
      const started = Date.now();
      try {
        this.logger.log(`Scraping ${scraper.displayName}…`);
        const tenders: Tender[] = await scraper.scrape(filters);
        const { newCount } = await this.tendersService.ingest(tenders);
        // After ingest, so the listing is stored even if the analysis fails.
        const analysis = await this.offerAnalysis.analyzeNew(scraper, tenders);
        // Listing and detail pages were read: the site's session (if any) works.
        // Not earlier: an expiry between the two would clear and re-send the alert every run.
        this.alerts.resolve(sessionAlertKind(scraper.site));
        if (scraper.manualSession) await this.reportSession(scraper, 'ok', new Date());
        if (analysis) await this.reportClaudeCredits(analysis);
        const aoEmails = analysis ? await this.emailRelevantOffers(scraper) : undefined;
        const result: ScrapeResult = {
          site: scraper.site,
          scrapedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          count: tenders.length,
          newCount,
          ...(analysis && { analysis }),
          ...(aoEmails && { aoEmails }),
        };
        results.push(result);
        this.logger.log(
          `${scraper.displayName}: ${tenders.length} tenders (${newCount} new) in ${result.durationMs}ms`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`${scraper.displayName} failed: ${message}`);
        if (err instanceof SessionMissingError) {
          const now = new Date();
          await this.alerts.raise(sessionExpiredAlert(scraper.site, scraper.displayName, now), now);
          // Red banner on MyBestConsultant's /admin/candidats until a run reads the site again; only for sites that
          // also report "ok", or the banner would never clear.
          if (scraper.manualSession) await this.reportSession(scraper, 'session_expired', now);
        }
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

  /**
   * Sends the session state to MyBestConsultant; if it does not get through,
   * the operator is emailed, since the banner would stay as it was.
   */
  private async reportSession(scraper: BaseScraper, state: SessionState, now: Date): Promise<void> {
    const problem = await this.mbcStatus.report(scraper.site, state, now);
    if (problem === undefined) this.alerts.resolve(MBC_STATUS_ALERT);
    else await this.alerts.raise(mbcStatusAlert(scraper.displayName, problem, now), now);
  }

  /** Emails the operator while Claude refuses for a credit problem; clears the alert once Claude answers again. */
  private async reportClaudeCredits(analysis: AnalysisSummary): Promise<void> {
    if (analysis.claudeCreditProblem !== undefined) {
      const now = new Date();
      await this.alerts.raise(claudeCreditsAlert(analysis.claudeCreditProblem, analysis.fallback, analysis.error, now), now);
    } else if (analysis.analyzed > 0) {
      // No credit problem this run, so every analysis came from Claude.
      this.alerts.resolve(CLAUDE_CREDITS_ALERT);
    }
  }

  /**
   * Sends the site's relevant offers not emailed yet to the AO inbox. Reported
   * in the run result, never a scrape failure: the offers stay stored and the
   * next run or `npm run ao:send` sends them.
   */
  private async emailRelevantOffers(scraper: BaseScraper): Promise<{ sent: number; refused: number; error?: string }> {
    try {
      return await sendRelevantOffers(
        this.repository,
        parseMailConfig(process.env),
        scraper.site,
        MAX_EMAILS_PER_SEND,
        process.env.DATA_DIR || './data',
        (message) => this.logger.log(message),
        scraper.documentsForEmail?.bind(scraper),
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`AO inbox emails not sent: ${error}`);
      return { sent: 0, refused: 0, error };
    }
  }
}
