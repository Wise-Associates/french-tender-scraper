import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { BaseScraper } from '../scrapers/base.scraper';
import { OfferDetails, Tender } from '../scrapers/tender.types';
import { TendersService } from '../tenders/tenders.service';
import { ClaudeAnalyzer, ClaudeUnavailableError } from './claude-analyzer.service';
import { AnalysisOutcome, AnalysisResult } from './offer-analysis';
import { MAX_ATTEMPTS_PER_OFFER, OfferAnalysisService } from './offer-analysis.service';

// Fictitious offers; the scraper, Claude and the database are replaced by fakes.
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
  details?: (tenders: Tender[]) => OfferDetails[];
  analyze?: (tender: Tender) => AnalysisResult | Error;
}) {
  const saved: { id: string; outcome: AnalysisOutcome; model: string; missionText: string | null }[] = [];
  const failures: Record<string, number> = { ...options.previousAttempts };
  const fetched: string[] = [];
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
      const result = options.analyze ? options.analyze(tender) : relevant;
      if (result instanceof Error) throw result;
      return { result, model: 'served-model', inputTokens: 100, outputTokens: 10 };
    },
  } as unknown as ClaudeAnalyzer;
  const config = { get: (key: string) => (key === 'ANALYSIS_MAX_PER_RUN' ? options.maxPerRun : undefined) } as ConfigService;
  const scraper = {
    site: 'partenaire-gc',
    displayName: 'Test',
    fetchDetails: async (list: Tender[]) => {
      fetched.push(...list.map((t) => t.externalId));
      return options.details ? options.details(list) : list.map((tender) => ({ tender, text: `Contact : rh@acme.test — ${tender.title}` }));
    },
  } as unknown as BaseScraper;
  return { service: new OfferAnalysisService(analyzer, tenders, config), scraper, saved, failures, fetched };
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
    assert.deepEqual(fetched, ['b', 'c']);
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
    assert.equal(saved[0].missionText, 'Contact : [email masqué] — Offre a');
    assert.equal(saved[0].outcome.kind === 'relevant' && saved[0].outcome.analysis.summary, 'Joindre [email masqué]');
    assert.equal(saved[1].missionText, null);
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
      details: (list) => list.map((tender) => (tender.externalId === 'a' ? { tender, error: 'No mission description', offerProblem: true } : { tender, text: 't' })),
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
      details: (list) => list.map((tender) => (tender.externalId === 'a' ? { tender, error: 'HTTP 503', offerProblem: false } : { tender, text: 't' })),
      analyze: () => new Error('Request timed out'),
    });
    const summary = await service.analyzeNew(scraper, [offer('a'), offer('b')]);
    assert.deepEqual(failures, {});
    assert.equal(summary?.failed, 2);
  });

  it('stops the batch at once when Claude rejects the request', async () => {
    const { service, scraper, saved } = setup({
      analyze: (tender) => (tender.externalId === 'b' ? new ClaudeUnavailableError('Claude API 401: invalid key') : relevant),
    });
    const summary = await service.analyzeNew(scraper, [offer('a'), offer('b'), offer('c')]);
    assert.deepEqual(saved.map((s) => s.id), ['a']);
    assert.equal(summary?.failed, 2);
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
    assert.equal(summary?.failed, 5);
    assert.match(summary?.error ?? '', /3 API errors in a row/);
  });
});
