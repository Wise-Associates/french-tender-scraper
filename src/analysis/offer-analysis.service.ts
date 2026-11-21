import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentText, documentsText } from '../documents/offer-documents';
import { BaseScraper, SessionMissingError } from '../scrapers/base.scraper';
import { AnalysisSummary, OfferDetails, Tender } from '../scrapers/tender.types';
import { TendersService } from '../tenders/tenders.service';
import { ANALYSIS_MODEL, ClaudeAnalyzer } from './claude-analyzer.service';
import { matchedItKeywords } from './it-keywords';
import { AnalyzerUnavailableError, ClaudeOutOfCreditsError, ModelAnalysis } from './model-analysis';
import { AnalysisOutcome, maskAnalysis, maskContactDetails, parseMaxPerRun } from './offer-analysis';
import { OpenAiAnalyzer } from './openai-analyzer.service';

/** Failures tied to an offer (unusable page or answer) before it is set aside. */
export const MAX_ATTEMPTS_PER_OFFER = 3;
/** Consecutive API errors (server errors, timeouts after the SDK's retries) before the batch stops. */
const MAX_CONSECUTIVE_API_ERRORS = 3;
/** Detail pages read per run: free, but each one is a request to the site. */
export const MAX_DETAIL_PAGES_PER_RUN = 40;
/** `model` recorded for offers the keyword filter set aside without calling Claude. */
export const KEYWORD_FILTER_MODEL = 'keyword-filter';

/**
 * After a scrape: reads the detail page of each offer not analysed yet, with
 * the text of its documents (ADR 0007), sets aside for free the offers with no
 * IT keyword (it-keywords.ts) and has Claude
 * classify the others, at most ANALYSIS_MAX_PER_RUN per run. Each offer is
 * analysed once. When Claude refuses for a credit problem, the rest of the
 * run goes to the OpenAI fallback if configured (ADR 0004). Failures tied to the offer
 * count as attempts and the offer is set aside after MAX_ATTEMPTS_PER_OFFER;
 * service failures (API or site down) count nothing and are retried next run.
 * Offer texts are never logged.
 */
@Injectable()
export class OfferAnalysisService {
  private readonly logger = new Logger(OfferAnalysisService.name);
  private readonly maxPerRun: number;

  constructor(
    private readonly claude: ClaudeAnalyzer,
    private readonly openai: OpenAiAnalyzer,
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
      analyzed: 0, relevant: 0, notRelevant: 0, refused: 0, filteredOut: 0, failed: 0, abandoned: 0, remaining: 0,
      inputTokens: 0, outputTokens: 0,
    };
    if (!this.claude.enabled) {
      summary.error = 'ANTHROPIC_API_KEY is not set: offers were not analysed';
      this.logger.warn(summary.error);
      return summary;
    }

    const pending = this.tenders.withoutAnalysis(scraper.site, tenders, MAX_ATTEMPTS_PER_OFFER);
    const batch = pending.slice(0, MAX_DETAIL_PAGES_PER_RUN);
    summary.remaining = pending.length - batch.length;
    if (batch.length === 0) return summary;

    this.logger.log(
      `Reading ${batch.length} new ${scraper.displayName} offer(s); up to ${this.maxPerRun} go to ${ANALYSIS_MODEL}…`,
    );
    let details: OfferDetails[];
    try {
      details = await scraper.fetchDetails(batch);
    } catch (err) {
      // Stops the site's run so the operator is told to log in again (ScrapingService).
      if (err instanceof SessionMissingError) throw err;
      summary.failed = batch.length;
      summary.error = `Detail pages not read: ${message(err)}`;
      this.logger.error(summary.error);
      return summary;
    }

    let consecutiveApiErrors = 0;
    let claudeCalls = 0;
    for (const [index, detail] of details.entries()) {
      if ('error' in detail) {
        if (detail.offerProblem) this.recordFailure(detail.tender, detail.error, summary);
        else {
          summary.failed += 1;
          this.logger.warn(`${idOf(detail.tender)}: details not read, retried next run — ${detail.error}`);
        }
        continue;
      }
      const keywords = matchedItKeywords(`${detail.tender.title}\n${detail.text}\n${documentsText(detail.documents)}`);
      if (keywords.length === 0) {
        this.tenders.saveAnalysis(detail.tender, { kind: 'not_relevant' }, KEYWORD_FILTER_MODEL, null, []);
        summary.filteredOut += 1;
        this.logger.log(`${idOf(detail.tender)}: no IT keyword, not sent to Claude`);
        continue;
      }
      if (claudeCalls >= this.maxPerRun) {
        // Passed the filter but over this run's Claude budget: next run.
        summary.remaining += 1;
        continue;
      }
      claudeCalls += 1;
      this.logger.log(`${idOf(detail.tender)}: IT keywords (${keywords.slice(0, 5).join(', ')}) → Claude`);
      try {
        const { result, model, inputTokens, outputTokens } = await this.analyzeOffer(detail, summary);
        consecutiveApiErrors = 0;
        summary.inputTokens += inputTokens;
        summary.outputTokens += outputTokens;
        if (result.kind === 'unusable') {
          this.recordFailure(detail.tender, `${model} answer unusable: ${result.reason}`, summary);
          continue;
        }
        this.save(detail.tender, result, model, detail.text, detail.documents);
        summary.analyzed += 1;
        if (result.kind === 'relevant') summary.relevant += 1;
        else if (result.kind === 'not_relevant') summary.notRelevant += 1;
        else {
          summary.refused += 1;
          this.logger.warn(`${idOf(detail.tender)}: ${model} declined to analyse it (${result.category ?? 'no category'})`);
        }
      } catch (err) {
        consecutiveApiErrors += 1;
        const stop =
          err instanceof AnalyzerUnavailableError
            ? err.message
            : consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS
              ? `${consecutiveApiErrors} API errors in a row, last: ${message(err)}`
              : undefined;
        if (stop) {
          // Same failure for the remaining offers: stop and retry them all next run.
          summary.failed += 1;
          summary.remaining += details.length - index - 1;
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
        `${summary.refused} declined, ${summary.filteredOut} without IT keyword, ${summary.failed} failed ` +
        `(${summary.inputTokens} input / ${summary.outputTokens} output tokens` +
        `${summary.fallback ? `, ${summary.fallback.answers} answer(s) from ${summary.fallback.model} after Claude's credit problem` : ''})`,
    );
    return summary;
  }

  /**
   * Claude first. Once Claude refuses for a credit problem, the rest of the run
   * goes to OpenAI when OPENAI_API_KEY is set, and the batch stops otherwise.
   * The next run tries Claude again, so topping up the credits is enough to
   * come back to it.
   */
  private async analyzeOffer(
    { tender, text, documents }: { tender: Tender; text: string; documents: DocumentText[] },
    summary: AnalysisSummary,
  ): Promise<ModelAnalysis> {
    if (summary.claudeCreditProblem === undefined) {
      try {
        return await this.claude.analyze(tender, text, documents);
      } catch (err) {
        if (!(err instanceof ClaudeOutOfCreditsError)) throw err;
        summary.claudeCreditProblem = err.message;
        if (!this.openai.enabled) throw err;
        this.logger.error(`${err.message} — the rest of this run goes to OpenAI ${this.openai.model}`);
      }
    }
    // Set before the call so a failing fallback still shows it was tried (answers: 0).
    summary.fallback ??= { model: this.openai.model, answers: 0 };
    const analysis = await this.openai.analyze(tender, text, documents);
    summary.fallback.answers += 1;
    return analysis;
  }

  /** Mission text and document links are kept for relevant offers only: they are emailed to the AO inbox. */
  private save(tender: Tender, outcome: AnalysisOutcome, model: string, missionText: string, documents: DocumentText[]): void {
    if (outcome.kind === 'relevant') {
      const links = documents.map(({ name, url }) => ({ name, url }));
      this.tenders.saveAnalysis(tender, { kind: 'relevant', analysis: maskAnalysis(outcome.analysis) }, model, maskContactDetails(missionText), links);
    } else {
      this.tenders.saveAnalysis(tender, outcome, model, null, []);
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
