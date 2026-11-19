import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { MbcStatusReporter, SessionState } from '../alerts/mbc-status';
import { OperatorAlert } from '../alerts/operator-alerts';
import { OperatorAlertsService } from '../alerts/operator-alerts.service';
import { OfferAnalysisService } from '../analysis/offer-analysis.service';
import { TendersRepository } from '../tenders/tenders.repository';
import { TendersService } from '../tenders/tenders.service';
import { BaseScraper, SessionMissingError } from './base.scraper';
import { ScrapingService } from './scraping.service';
import { AnalysisSummary, ScrapeResult } from './tender.types';

// The scraper, the analysis, the database and the alerts are fakes; no AO email can be sent
// (no SMTP settings in the test environment, and no relevant offer in the fake repository).
const summary = (fields: Partial<AnalysisSummary>): AnalysisSummary => ({
  analyzed: 0, relevant: 0, notRelevant: 0, refused: 0, filteredOut: 0, failed: 0, abandoned: 0, remaining: 0,
  inputTokens: 0, outputTokens: 0,
  ...fields,
});

function setup(options: {
  scrape?: () => Promise<[]>;
  analyzeNew?: () => Promise<AnalysisSummary | undefined>;
  manualSession?: boolean;
  mbcProblem?: string;
}) {
  const raised: OperatorAlert[] = [];
  const resolved: string[] = [];
  const reported: [string, SessionState][] = [];
  const mbcStatus = {
    report: async (site: string, state: SessionState) => {
      reported.push([site, state]);
      return options.mbcProblem;
    },
  } as unknown as MbcStatusReporter;
  const alerts = {
    raise: async (alert: OperatorAlert) => void raised.push(alert),
    resolve: (kind: string) => void resolved.push(kind),
  } as unknown as OperatorAlertsService;
  const scraper = {
    site: 'partenaire-gc',
    displayName: 'Partenaire GC',
    isEnabled: () => true,
    manualSession: options.manualSession ?? true,
    scrape: options.scrape ?? (async () => []),
  } as unknown as BaseScraper;
  const service = new ScrapingService(
    [scraper],
    { ingest: async () => ({ stored: 0, newCount: 0 }) } as unknown as TendersService,
    { analyzeNew: options.analyzeNew ?? (async () => undefined) } as unknown as OfferAnalysisService,
    { relevantNotEmailed: () => [] } as unknown as TendersRepository,
    alerts,
    mbcStatus,
  );
  return { service, raised, resolved, reported };
}

/** Runs the scrape without waiting for the 5-second politeness gap between sites. */
async function run(service: ScrapingService): Promise<ScrapeResult[]> {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let done = false;
    const result = service.run();
    result.then(() => (done = true), () => (done = true));
    while (!done) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(5_000);
    }
    return await result;
  } finally {
    mock.timers.reset();
  }
}

const expired = new SessionMissingError('Partenaire GC session missing or expired');

describe('ScrapingService — operator alerts', () => {
  it('raises the session alert and tells MyBestConsultant when the listing needs a login', async () => {
    const { service, raised, resolved, reported } = setup({ scrape: () => Promise.reject(expired) });
    const [result] = await run(service);
    assert.match(result.error ?? '', /session missing or expired/);
    assert.deepEqual(raised.map((a) => a.kind), ['session:partenaire-gc']);
    assert.deepEqual(resolved, ['mbc-status'], 'the state got through; the session alert stays');
    assert.deepEqual(reported, [['partenaire-gc', 'session_expired']]);
  });

  it('raises it, without clearing it first, when the session expires on the detail pages', async () => {
    const { service, raised, resolved, reported } = setup({ analyzeNew: () => Promise.reject(expired) });
    await run(service);
    assert.deepEqual(raised.map((a) => a.kind), ['session:partenaire-gc']);
    assert.ok(!resolved.includes('session:partenaire-gc'), 'clearing it would re-send the alert at every run');
    assert.deepEqual(reported, [['partenaire-gc', 'session_expired']], 'never "ok" first');
  });

  it('clears the session alert and tells MyBestConsultant after a run that read the site', async () => {
    const { service, raised, resolved, reported } = setup({});
    await run(service);
    assert.deepEqual(raised, []);
    assert.deepEqual(resolved, ['session:partenaire-gc', 'mbc-status']);
    assert.deepEqual(reported, [['partenaire-gc', 'ok']]);
  });

  it('emails the operator when MyBestConsultant refuses the state, since its banner would stay as it was', async () => {
    const { service, raised, resolved } = setup({ mbcProblem: 'HTTP 401 {"error":"Non autorisé"}' });
    await run(service);
    assert.deepEqual(raised.map((a) => a.kind), ['mbc-status']);
    assert.match(raised[0].text, /HTTP 401/);
    assert.ok(!resolved.includes('mbc-status'));
  });

  it('reports nothing to MyBestConsultant for a site without a manual session, even when it needs a login', async () => {
    const { service, reported } = setup({ manualSession: false });
    await run(service);
    const expiredElsewhere = setup({ manualSession: false, scrape: () => Promise.reject(expired) });
    await run(expiredElsewhere.service);
    assert.deepEqual([...reported, ...expiredElsewhere.reported], [], 'a banner nothing would ever clear');
  });

  it('raises the credits alert when Claude had a credit problem', async () => {
    const { service, raised, resolved } = setup({
      analyzeNew: async () => summary({ claudeCreditProblem: 'Claude API 402 (billing_error)', fallback: { model: 'gpt-test', answers: 2 } }),
    });
    await run(service);
    assert.deepEqual(raised.map((a) => a.kind), ['claude-credits']);
    assert.match(raised[0].subject, /basculée sur gpt-test/);
    assert.ok(!resolved.includes('claude-credits'));
  });

  it('clears the credits alert only once Claude answered again', async () => {
    const answered = setup({ analyzeNew: async () => summary({ analyzed: 1 }) });
    await run(answered.service);
    assert.ok(answered.resolved.includes('claude-credits'));

    const nothingAnalysed = setup({ analyzeNew: async () => summary({ filteredOut: 2 }) });
    await run(nothingAnalysed.service);
    assert.ok(!nothingAnalysed.resolved.includes('claude-credits'));
  });

  it('raises nothing for other failures, and keeps the last state in MyBestConsultant', async () => {
    const { service, raised, reported } = setup({ scrape: () => Promise.reject(new Error('HTTP 503 from partenaire-gc.com')) });
    await run(service);
    assert.deepEqual(raised, []);
    assert.deepEqual(reported, []);
  });
});
