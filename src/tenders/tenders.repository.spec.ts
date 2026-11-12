import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { OfferAnalysis } from '../analysis/offer-analysis';
import { Tender } from '../scrapers/tender.types';
import { TendersRepository } from './tenders.repository';

// Fictitious offers.
const offer = (externalId: string, site: Tender['site'] = 'partenaire-gc'): Tender => ({
  site,
  externalId,
  title: `Offre ${externalId}`,
  url: `https://example.test/${externalId}`,
});
const analysis: OfferAnalysis = {
  categories: ['data_ia'],
  summary: 'Mission data.',
  skills: ['Python'],
  seniority: null,
  duration: '3 mois',
  start_date: null,
  remote: null,
};

describe('TendersRepository — Claude analyses', () => {
  let dir: string;
  let repository: TendersRepository;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tenders-repo-'));
    repository = new TendersRepository({ get: (key: string) => (key === 'DATA_DIR' ? dir : undefined) } as ConfigService);
    repository.upsertMany([offer('a'), offer('b'), offer('c'), offer('x', 'bpifrance')]);
    repository.saveAnalysis('partenaire-gc', 'a', { kind: 'relevant', analysis }, 'test-model', 'Texte de mission');
    repository.saveAnalysis('partenaire-gc', 'b', { kind: 'not_relevant' }, 'test-model', 'Texte à ne pas garder');
  });

  after(() => {
    repository.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists only the offers that were never analysed', () => {
    assert.deepEqual(repository.withoutAnalysis('partenaire-gc', ['a', 'b', 'c'], 3), ['c']);
  });

  it('counts failed attempts and leaves out offers that reached the limit', () => {
    assert.equal(repository.recordAnalysisFailure('partenaire-gc', 'c', 'no description'), 1);
    assert.equal(repository.recordAnalysisFailure('partenaire-gc', 'c', 'no description'), 2);
    assert.deepEqual(repository.withoutAnalysis('partenaire-gc', ['c'], 3), ['c']);
    assert.deepEqual(repository.withoutAnalysis('partenaire-gc', ['c'], 2), []);
  });

  it('returns relevant offers with their parsed analysis and mission text', () => {
    const { total, rows } = repository.find({ relevant: true });
    assert.equal(total, 1);
    assert.equal(rows[0].external_id, 'a');
    assert.deepEqual(rows[0].analysis?.categories, ['data_ia']);
    assert.deepEqual(rows[0].analysis?.skills, ['Python']);
    assert.equal(rows[0].analysis?.missionText, 'Texte de mission');
  });

  it('keeps only the outcome of a non-relevant offer, never its details', () => {
    const row = repository.find({ relevant: false }).rows.find((r) => r.external_id === 'b');
    assert.equal(row?.analysis?.outcome, 'not_relevant');
    assert.equal(row?.analysis?.summary, null);
    assert.equal(row?.analysis?.missionText, null);
  });

  it('treats unanalysed offers as not relevant, with no analysis', () => {
    const ids = repository.find({ relevant: false, site: 'partenaire-gc' }).rows.map((r) => r.external_id).sort();
    assert.deepEqual(ids, ['b', 'c']);
    assert.equal(repository.find({ site: 'bpifrance' }).rows[0].analysis, null);
  });

  it('replaces an analysis when the same offer is analysed again, and clears its failures', () => {
    repository.saveAnalysis('partenaire-gc', 'c', { kind: 'refused', category: 'cyber' }, 'test-model', null);
    repository.saveAnalysis('partenaire-gc', 'c', { kind: 'relevant', analysis }, 'test-model', 'Nouveau texte');
    const row = repository.find({ relevant: true }).rows.find((r) => r.external_id === 'c');
    assert.equal(row?.analysis?.outcome, 'relevant');
    assert.equal(row?.analysis?.missionText, 'Nouveau texte');
    const db = new Database(join(dir, 'tenders.db'), { readonly: true });
    const stored = db.prepare("SELECT refusal_category FROM tender_analyses WHERE external_id = 'c'").get() as { refusal_category: string | null };
    const failures = db.prepare("SELECT COUNT(*) AS n FROM tender_analysis_failures WHERE external_id = 'c'").get() as { n: number };
    db.close();
    assert.equal(stored.refusal_category, null);
    assert.equal(failures.n, 0);
  });
});

describe('TendersRepository — offers emailed to the AO inbox', () => {
  it('returns relevant, not yet emailed, still open offers, most urgent first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tenders-repo-ao-'));
    const repository = new TendersRepository({ get: (key: string) => (key === 'DATA_DIR' ? dir : undefined) } as ConfigService);
    try {
      const withDeadline = (id: string, deadlineAt: string | undefined): Tender => ({ ...offer(id), deadlineAt });
      repository.upsertMany([
        withDeadline('late', '2026-12-20T10:00:00.000Z'),
        withDeadline('soon', '2026-11-20T10:00:00.000Z'),
        withDeadline('no-deadline', undefined),
        withDeadline('past', '2026-11-01T10:00:00.000Z'),
        withDeadline('not-relevant', '2026-11-25T10:00:00.000Z'),
      ]);
      for (const id of ['late', 'soon', 'no-deadline', 'past']) {
        repository.saveAnalysis('partenaire-gc', id, { kind: 'relevant', analysis }, 'test-model', 'Texte');
      }
      repository.saveAnalysis('partenaire-gc', 'not-relevant', { kind: 'not_relevant' }, 'test-model', null);
      const now = '2026-11-12T10:00:00.000Z';

      assert.deepEqual(repository.relevantNotEmailed('partenaire-gc', now, 10).map((r) => r.external_id), ['soon', 'late', 'no-deadline']);
      assert.deepEqual(repository.relevantNotEmailed('bpifrance', now, 10), []);
      assert.deepEqual(repository.relevantNotEmailed('partenaire-gc', now, 1).map((r) => r.external_id), ['soon']);

      repository.markEmailed('partenaire-gc', 'soon', '<message@test>');
      repository.markEmailed('partenaire-gc', 'soon', '<again@test>');
      assert.deepEqual(repository.relevantNotEmailed('partenaire-gc', now, 10).map((r) => r.external_id), ['late', 'no-deadline']);
    } finally {
      repository.onModuleDestroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('TendersRepository — database created before the Claude analysis', () => {
  it('opens it, adds the new tables and returns its offers without analysis', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tenders-repo-old-'));
    try {
      // The schema as it was before tender_analyses existed.
      const old = new Database(join(dir, 'tenders.db'));
      old.exec(`CREATE TABLE tenders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL,
        buyer TEXT, description TEXT, url TEXT, published_at TEXT, deadline_at TEXT, cpv_codes TEXT, region TEXT,
        contract_type TEXT, first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(site, external_id))`);
      old.prepare("INSERT INTO tenders (site, external_id, title, url) VALUES ('bpifrance', 'old-1', 'Ancienne offre', 'https://example.test')").run();
      old.close();

      const repository = new TendersRepository({ get: (key: string) => (key === 'DATA_DIR' ? dir : undefined) } as ConfigService);
      const { rows } = repository.find({});
      repository.onModuleDestroy();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].external_id, 'old-1');
      assert.equal(rows[0].analysis, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
