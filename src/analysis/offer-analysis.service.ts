import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseScraper } from '../scrapers/base.scraper';
import { AnalysisSummary, OfferDetails, Tender } from '../scrapers/tender.types';
import { TendersService } from '../tenders/tenders.service';
import { ANALYSIS_MODEL, ClaudeAnalyzer, ClaudeUnavailableError } from './claude-analyzer.service';
import { AnalysisOutcome, maskAnalysis, maskContactDetails, parseMaxPerRun } from './offer-analysis';

/** Failures tied to an offer (unusable page or answer) before it is set aside. */
export const MAX_ATTEMPTS_PER_OFFER = 3;
/** Consecutive API errors (server errors, timeouts after the SDK's retries) before the batch stops. */
const MAX_CONSECUTIVE_API_ERRORS = 3;

/**
 * After a scrape: reads the detail page of each offer not analysed yet and has
 * Claude classify it. Each offer is analysed once. Failures tied to the offer
 * count as attempts and the offer is set aside after MAX_ATTEMPTS_PER_OFFER;
 * service failures (API or site down) count nothing and are retried next run.
 * Offer texts are never logged.
 */
@Injectable()
export class OfferAnalysisService {
  private readonly logger = new Logger(OfferAnalysisService.name);
  private readonly maxPerRun: number;

  constructor(
    private readonly analyzer: ClaudeAnalyzer,
    private readonly tenders: TendersService,
    config: ConfigService,
  ) {
    // Validated at startup: a bad value stops the server with a clear message
    // instead of failing scrapes later.
    this.maxPerRun = parseMaxPerRun(config.get<string>('ANALYSIS_MAX_PER_RUN'));
  }

  /** undefined when the site has no detail pages to analyse. */
  async analyzeNew(scraper: BaseScraper, tenders: Tender[]): Promise<AnalysisSummary | undefined> {
    if (!scraper.fetchDetails) return undefined;
    const summary: AnalysisSummary = {
      analyzed: 0, relevant: 0, notRelevant: 0, refused: 0, failed: 0, abandoned: 0, remaining: 0,
      inputTokens: 0, outputTokens: 0,
    };
    if (!this.analyzer.enabled) {
      summary.error = 'ANTHROPIC_API_KEY is not set: offers were not analysed';
      this.logger.warn(summary.error);
      return summary;
    }

    const pending = this.tenders.withoutAnalysis(scraper.site, tenders, MAX_ATTEMPTS_PER_OFFER);
    const batch = pending.slice(0, this.maxPerRun);
    summary.remaining = pending.length - batch.length;
    if (batch.length === 0) return summary;

    this.logger.log(`Analysing ${batch.length} new ${scraper.displayName} offer(s) with ${ANALYSIS_MODEL}…`);
    let details: OfferDetails[];
    try {
      details = await scraper.fetchDetails(batch);
    } catch (err) {
      summary.failed = batch.length;
      summary.error = `Detail pages not read: ${message(err)}`;
      this.logger.error(summary.error);
      return summary;
    }

    let consecutiveApiErrors = 0;
    for (const [index, detail] of details.entries()) {
      if ('error' in detail) {
        if (detail.offerProblem) this.recordFailure(detail.tender, detail.error, summary);
        else {
          summary.failed += 1;
          this.logger.warn(`${idOf(detail.tender)}: details not read, retried next run — ${detail.error}`);
        }
        continue;
      }
      try {
        const { result, model, inputTokens, outputTokens } = await this.analyzer.analyze(detail.tender, detail.text);
        consecutiveApiErrors = 0;
        summary.inputTokens += inputTokens;
        summary.outputTokens += outputTokens;
        if (result.kind === 'unusable') {
          this.recordFailure(detail.tender, `Claude answer unusable: ${result.reason}`, summary);
          continue;
        }
        this.save(detail.tender, result, model, detail.text);
        summary.analyzed += 1;
        if (result.kind === 'relevant') summary.relevant += 1;
        else if (result.kind === 'not_relevant') summary.notRelevant += 1;
        else {
          summary.refused += 1;
          this.logger.warn(`${idOf(detail.tender)}: Claude declined to analyse it (${result.category ?? 'no category'})`);
        }
      } catch (err) {
        consecutiveApiErrors += 1;
        const stop =
          err instanceof ClaudeUnavailableError
            ? err.message
            : consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS
              ? `${consecutiveApiErrors} API errors in a row, last: ${message(err)}`
              : undefined;
        if (stop) {
          // Same failure for the remaining offers: stop and retry them all next run.
          summary.failed += details.length - index;
          summary.error = `Analysis stopped: ${stop}`;
          this.logger.error(summary.error);
          return summary;
        }
        summary.failed += 1;
        this.logger.warn(`${idOf(detail.tender)}: API error, retried next run — ${message(err)}`);
      }
    }
    this.logger.log(
      `${scraper.displayName}: ${summary.relevant} relevant, ${summary.notRelevant} not relevant, ` +
        `${summary.refused} declined, ${summary.failed} failed ` +
        `(${summary.inputTokens} input / ${summary.outputTokens} output tokens)`,
    );
    return summary;
  }

  private save(tender: Tender, outcome: AnalysisOutcome, model: string, missionText: string): void {
    if (outcome.kind === 'relevant') {
      this.tenders.saveAnalysis(tender, { kind: 'relevant', analysis: maskAnalysis(outcome.analysis) }, model, maskContactDetails(missionText));
    } else {
      this.tenders.saveAnalysis(tender, outcome, model, null);
    }
  }

  private recordFailure(tender: Tender, reason: string, summary: AnalysisSummary): void {
    const attempts = this.tenders.recordAnalysisFailure(tender, reason);
    summary.failed += 1;
    if (attempts >= MAX_ATTEMPTS_PER_OFFER) {
      summary.abandoned += 1;
      this.logger.warn(
        `${idOf(tender)}: set aside after ${attempts} failed attempts — ${reason}. ` +
          'Delete its row from tender_analysis_failures to try again.',
      );
    } else {
      this.logger.warn(`${idOf(tender)}: attempt ${attempts}/${MAX_ATTEMPTS_PER_OFFER} failed, retried next run — ${reason}`);
    }
  }
}

function idOf(tender: Tender): string {
  return `${tender.site}:${tender.externalId}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
