import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { BaseScraper, SessionMissingError } from '../scrapers/base.scraper';
import { OfferDetails, Tender } from '../scrapers/tender.types';
import { TendersService } from '../tenders/tenders.service';
import { ClaudeAnalyzer } from './claude-analyzer.service';
import { AnalyzerUnavailableError, ClaudeOutOfCreditsError } from './model-analysis';
import { AnalysisOutcome, AnalysisResult } from './offer-analysis';
import { KEYWORD_FILTER_MODEL, MAX_ATTEMPTS_PER_OFFER, OfferAnalysisService } from './offer-analysis.service';
import { OpenAiAnalyzer } from './openai-analyzer.service';

// Fictitious offers; the scraper, Claude, OpenAI and the database are replaced by fakes.
const offer = (externalId: string): Tender => ({
  site: 'partenaire-gc',
  externalId,
  title: `Offre ${externalId}`,
  url: `https://partenaire-gc.com/consultations/${externalId}`,
});
const relevant: AnalysisOutcome = {
  kind: 'relevant',
  analysis: { categories: ['data_ia'], summary: 'Joindre rh@acme.test', skills: [], seniority: null, duration: null, start_date: null, remote: null },
};

function setup(options: {
  analysed?: string[];
  previousAttempts?: Record<string, number>;
  maxPerRun?: string;
  apiKeySet?: boolean;
  details?: (tenders: Tender[]) => OfferDetails[] | Error;
  analyze?: (tender: Tender) => AnalysisResult | Error;
  openaiKeySet?: boolean;
  openaiAnalyze?: (tender: Tender) => AnalysisResult | Error;
}) {
  const saved: { id: string; outcome: AnalysisOutcome; model: string; missionText: string | null }[] = [];
  const failures: Record<string, number> = { ...options.previousAttempts };
  const fetched: string[] = [];
  const claudeCalls: string[] = [];
  const openaiCalls: string[] = [];
  const analysed = new Set(options.analysed ?? []);
  const tenders = {
    withoutAnalysis: (_site: string, list: Tender[], maxAttempts: number) =>
      list.filter((t) => !analysed.has(t.externalId) && (failures[t.externalId] ?? 0) < maxAttempts),
    saveAnalysis: (tender: Tender, outcome: AnalysisOutcome, model: string, missionText: string | null) =>
      saved.push({ id: tender.externalId, outcome, model, missionText }),
    recordAnalysisFailure: (tender: Tender) => (failures[tender.externalId] = (failures[tender.externalId] ?? 0) + 1),
  } as unknown as TendersService;
  const analyzer = {
    enabled: options.apiKeySet ?? true,
    analyze: async (tender: Tender) => {
      claudeCalls.push(tender.externalId);
      const result = options.analyze ? options.analyze(tender) : relevant;
      if (result instanceof Error) throw result;
      return { result, model: 'served-model', inputTokens: 100, outputTokens: 10 };
    },
  } as unknown as ClaudeAnalyzer;
  const openai = {
    enabled: options.openaiKeySet ?? false,
    model: 'gpt-test',
    analyze: async (tender: Tender) => {
      openaiCalls.push(tender.externalId);
      const result = options.openaiAnalyze ? options.openaiAnalyze(tender) : relevant;
      if (result instanceof Error) throw result;
      return { result, model: 'gpt-test-2026', inputTokens: 50, outputTokens: 5 };
    },
  } as unknown as OpenAiAnalyzer;
  const config = { get: (key: string) => (key === 'ANALYSIS_MAX_PER_RUN' ? options.maxPerRun : undefined) } as ConfigService;
  const scraper = {
    site: 'partenaire-gc',
    displayName: 'Test',
    fetchDetails: async (list: Tender[]) => {
      fetched.push(...list.map((t) => t.externalId));
      const details = options.details ? options.details(list) : list.map((tender) => ({ tender, text: `Contact : rh@acme.test — Développeur Java, ${tender.title}` }));
      if (details instanceof Error) throw details;
      return details;
    },
  } as unknown as BaseScraper;
  return { service: new OfferAnalysisService(analyzer, openai, tenders, config), scraper, saved, failures, fetched, claudeCalls, openaiCalls };
}

describe('OfferAnalysisService', () => {
  it('refuses to start with an invalid ANALYSIS_MAX_PER_RUN', () => {
    assert.throws(() => setup({ maxPerRun: 'ten' }), /ANALYSIS_MAX_PER_RUN/);
  });

  it('does nothing for a site without detail pages', async () => {
    const { service } = setup({});
    assert.equal(await service.analyzeNew({ site: 'bpifrance' } as unknown as BaseScraper, [offer('a')]), undefined);
  });

  it('reports, without reading any page, when no API key is set', async () => {
    const { service, scraper, fetched } = setup({ apiKeySet: false });
    const summary = await service.analyzeNew(scraper, [offer('a')]);
    assert.match(summary?.error ?? '', /ANTHROPIC_API_KEY/);
    assert.deepEqual(fetched, []);
  });

  it('analyses only offers never analysed, up to ANALYSIS_MAX_PER_RUN', async () => {
    const { service, scraper, fetched, saved } = setup({ analysed: ['a'], maxPerRun: '2' });
    const summary = await service.analyzeNew(scraper, [offer('a'), offer('b'), offer('c'), offer('d')]);
    assert.deepEqual(fetched, ['b', 'c', 'd'], 'detail pages are free: all pending offers are read');
    assert.deepEqual(saved.map((s) => s.id), ['b', 'c']);
    assert.equal(summary?.remaining, 1);
    assert.equal(summary?.inputTokens, 200);
  });

  it('stores the model that answered and masked details for relevant offers only', async () => {
    const { service, scraper, saved } = setup({
      analyze: (tender) => (tender.externalId === 'a' ? relevant : { kind: 'not_relevant' }),
    });
    await service.analyzeNew(scraper, [offer('a'), offer('b')]);
    assert.equal(saved[0].model, 'served-model');
    assert.equal(saved[0].missionText, 'Contact : [email masqué] — Développeur Java, Offre a');
    assert.equal(saved[0].outcome.kind === 'relevant' && saved[0].outcome.analysis.summary, 'Joindre [email masqué]');
    assert.equal(saved[1].missionText, null);
  });

  it('sets aside offers with no IT keyword without calling Claude', async () => {
    const calls: string[] = [];
    const { service, scraper, saved } = setup({
      details: (list) =>
        list.map((tender) => ({ tender, text: tender.externalId === 'a' ? 'Comptabilité et trésorerie' : 'Équipe agile, développeur Java' })),
      analyze: (tender) => {
        calls.push(tender.externalId);
        return relevant;
      },
    });
    const summary = await service.analyzeNew(scraper, [offer('a'), offer('b')]);
    assert.deepEqual(calls, ['b']);
    assert.deepEqual(saved.map((s) => [s.id, s.outcome.kind, s.model]), [
      ['a', 'not_relevant', KEYWORD_FILTER_MODEL],
      ['b', 'relevant', 'served-model'],
    ]);
    assert.equal(summary?.filteredOut, 1);
    assert.equal(summary?.inputTokens, 100);
  });

  it('counts ANALYSIS_MAX_PER_RUN on offers that passed the filter; 0 runs the filter only', async () => {
    const calls: string[] = [];
    const { service, scraper, saved } = setup({
      maxPerRun: '0',
      details: (list) => list.map((tender) => ({ tender, text: tender.externalId === 'a' ? 'Juridique' : 'Data engineer' })),
      analyze: (tender) => {
        calls.push(tender.externalId);
        return relevant;
      },
    });
    const summary = await service.analyzeNew(scraper, [offer('a'), offer('b')]);
    assert.deepEqual(calls, []);
    assert.deepEqual(saved.map((s) => s.id), ['a']);
    assert.equal(summary?.filteredOut, 1);
    assert.equal(summary?.remaining, 1);
  });

  it('records a refusal once instead of retrying it', async () => {
    const { service, scraper, saved } = setup({ analyze: () => ({ kind: 'refused', category: 'cyber' }) });
    const summary = await service.analyzeNew(scraper, [offer('a')]);
    assert.deepEqual(saved.map((s) => s.outcome), [{ kind: 'refused', category: 'cyber' }]);
    assert.equal(summary?.refused, 1);
  });

  it('counts offer problems as attempts and sets the offer aside at the limit', async () => {
    const { service, scraper, saved, failures } = setup({
      previousAttempts: { b: MAX_ATTEMPTS_PER_OFFER - 1 },
      details: (list) => list.map((tender) => (tender.externalId === 'a' ? { tender, error: 'No mission description', offerProblem: true } : { tender, text: 'Développeur Java' })),
      analyze: () => ({ kind: 'unusable', reason: 'stop_reason "max_tokens"' }),
    });
    const summary = await service.analyzeNew(scraper, [offer('a'), offer('b')]);
    assert.deepEqual(saved, []);
    assert.deepEqual(failures, { a: 1, b: MAX_ATTEMPTS_PER_OFFER });
    assert.equal(summary?.failed, 2);
    assert.equal(summary?.abandoned, 1);
    assert.equal(summary?.inputTokens, 100, 'the billed but unusable call is still counted');
  });

  it('does not analyse an offer already set aside', async () => {
    const { service, scraper, fetched } = setup({ previousAttempts: { a: MAX_ATTEMPTS_PER_OFFER } });
    await service.analyzeNew(scraper, [offer('a'), offer('b')]);
    assert.deepEqual(fetched, ['b']);
  });

  it('does not count site or API outages against the offer', async () => {
    const { service, scraper, failures } = setup({
      details: (list) => list.map((tender) => (tender.externalId === 'a' ? { tender, error: 'HTTP 503', offerProblem: false } : { tender, text: 'Développeur Java' })),
      analyze: () => new Error('Request timed out'),
    });
    const summary = await service.analyzeNew(scraper, [offer('a'), offer('b')]);
    assert.deepEqual(failures, {});
    assert.equal(summary?.failed, 2);
  });

  it('stops the batch at once when Claude rejects the request', async () => {
    const { service, scraper, saved } = setup({
      analyze: (tender) => (tender.externalId === 'b' ? new AnalyzerUnavailableError('Claude API 401: invalid key') : relevant),
    });
    const summary = await service.analyzeNew(scraper, [offer('a'), offer('b'), offer('c')]);
    assert.deepEqual(saved.map((s) => s.id), ['a']);
    assert.equal(summary?.failed, 1);
    assert.equal(summary?.remaining, 1);
    assert.match(summary?.error ?? '', /401/);
  });

  it('stops the batch after 3 API errors in a row', async () => {
    const calls: string[] = [];
    const { service, scraper } = setup({
      analyze: (tender) => {
        calls.push(tender.externalId);
        return new Error('Internal server error');
      },
    });
    const summary = await service.analyzeNew(scraper, ['a', 'b', 'c', 'd', 'e'].map(offer));
    assert.deepEqual(calls, ['a', 'b', 'c']);
    assert.equal(summary?.failed, 3);
    assert.equal(summary?.remaining, 2);
    assert.match(summary?.error ?? '', /3 API errors in a row/);
  });

  it('stops the run when the session expires while detail pages are read', async () => {
    const { service, scraper } = setup({ details: () => new SessionMissingError('Partenaire GC session missing or expired') });
    await assert.rejects(service.analyzeNew(scraper, [offer('a')]), SessionMissingError);
  });
});

describe('OfferAnalysisService — OpenAI fallback after a Claude credit problem', () => {
  const outOfCredits = new ClaudeOutOfCreditsError('Claude API 402 (billing_error): credit balance too low');

  it('sends the offer and the rest of the run to OpenAI, without retrying Claude', async () => {
    const { service, scraper, saved, claudeCalls, openaiCalls } = setup({
      openaiKeySet: true,
      analyze: (tender) => (tender.externalId === 'a' ? relevant : outOfCredits),
    });
    const summary = await service.analyzeNew(scraper, ['a', 'b', 'c'].map(offer));
    assert.deepEqual(claudeCalls, ['a', 'b']);
    assert.deepEqual(openaiCalls, ['b', 'c']);
    assert.deepEqual(saved.map((s) => [s.id, s.model]), [
      ['a', 'served-model'],
      ['b', 'gpt-test-2026'],
      ['c', 'gpt-test-2026'],
    ]);
    assert.equal(summary?.claudeCreditProblem, outOfCredits.message);
    assert.deepEqual(summary?.fallback, { model: 'gpt-test', answers: 2 });
    assert.equal(summary?.analyzed, 3);
    assert.equal(summary?.inputTokens, 200);
    assert.equal(summary?.error, undefined);
  });

  it('counts fallback calls in ANALYSIS_MAX_PER_RUN', async () => {
    const { service, scraper, openaiCalls } = setup({ openaiKeySet: true, maxPerRun: '2', analyze: () => outOfCredits });
    const summary = await service.analyzeNew(scraper, ['a', 'b', 'c'].map(offer));
    assert.deepEqual(openaiCalls, ['a', 'b']);
    assert.equal(summary?.remaining, 1);
  });

  it('stops the batch, as before, when no OpenAI key is set', async () => {
    const { service, scraper, saved, openaiCalls } = setup({
      analyze: (tender) => (tender.externalId === 'a' ? relevant : outOfCredits),
    });
    const summary = await service.analyzeNew(scraper, ['a', 'b', 'c'].map(offer));
    assert.deepEqual(saved.map((s) => s.id), ['a']);
    assert.deepEqual(openaiCalls, []);
    assert.equal(summary?.claudeCreditProblem, outOfCredits.message);
    assert.equal(summary?.fallback, undefined);
    assert.equal(summary?.remaining, 1);
    assert.match(summary?.error ?? '', /Analysis stopped: Claude API 402/);
  });

  it('does not fall back on other Claude errors', async () => {
    const { service, scraper, openaiCalls } = setup({
      openaiKeySet: true,
      analyze: () => new AnalyzerUnavailableError('Claude API 401: invalid key'),
    });
    const summary = await service.analyzeNew(scraper, [offer('a')]);
    assert.deepEqual(openaiCalls, []);
    assert.equal(summary?.claudeCreditProblem, undefined);
    assert.match(summary?.error ?? '', /401/);
  });

  it('stops the batch when OpenAI rejects the request too', async () => {
    const { service, scraper, saved } = setup({
      openaiKeySet: true,
      analyze: () => outOfCredits,
      openaiAnalyze: () => new AnalyzerUnavailableError('OpenAI API 429: insufficient_quota'),
    });
    const summary = await service.analyzeNew(scraper, ['a', 'b'].map(offer));
    assert.deepEqual(saved, []);
    assert.equal(summary?.remaining, 1);
    assert.match(summary?.error ?? '', /OpenAI API 429/);
    assert.deepEqual(summary?.fallback, { model: 'gpt-test', answers: 0 }, 'tried, but gave no answer');
  });
});
