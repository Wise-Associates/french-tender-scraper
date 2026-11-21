import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { AnalysisOutcome } from '../analysis/offer-analysis';
import { DocumentLink } from '../documents/offer-documents';
import { Tender } from '../scrapers/tender.types';

export interface TenderRow {
  id: number;
  site: string;
  external_id: string;
  title: string;
  buyer: string | null;
  description: string | null;
  url: string;
  published_at: string | null;
  deadline_at: string | null;
  cpv_codes: string | null;
  region: string | null;
  contract_type: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

/** Claude analysis as returned by the API; null when the offer was never analysed. */
export interface TenderAnalysisView {
  outcome: 'relevant' | 'not_relevant' | 'refused';
  categories: string[];
  summary: string | null;
  skills: string[];
  seniority: string | null;
  duration: string | null;
  startDate: string | null;
  remote: string | null;
  missionText: string | null;
  model: string;
  analyzedAt: string;
}

export type TenderWithAnalysis = TenderRow & { analysis: TenderAnalysisView | null };

interface AnalysisColumns {
  a_outcome: TenderAnalysisView['outcome'] | null;
  a_categories: string | null;
  a_summary: string | null;
  a_skills: string | null;
  a_seniority: string | null;
  a_duration: string | null;
  a_start_date: string | null;
  a_remote: string | null;
  a_mission_text: string | null;
  a_model: string | null;
  a_analyzed_at: string | null;
}

const ANALYSIS_COLUMNS = [
  'outcome', 'categories', 'summary', 'skills', 'seniority', 'duration',
  'start_date', 'remote', 'mission_text', 'model', 'analyzed_at',
].map((column) => `a.${column} AS a_${column}`).join(', ');

function withAnalysis(row: TenderRow & AnalysisColumns): TenderWithAnalysis {
  const {
    a_outcome, a_categories, a_summary, a_skills, a_seniority, a_duration,
    a_start_date, a_remote, a_mission_text, a_model, a_analyzed_at, ...tender
  } = row;
  return {
    ...tender,
    analysis:
      a_outcome === null
        ? null
        : {
            outcome: a_outcome,
            categories: a_categories ? (JSON.parse(a_categories) as string[]) : [],
            summary: a_summary,
            skills: a_skills ? (JSON.parse(a_skills) as string[]) : [],
            seniority: a_seniority,
            duration: a_duration,
            startDate: a_start_date,
            remote: a_remote,
            missionText: a_mission_text,
            model: a_model ?? '',
            analyzedAt: a_analyzed_at ?? '',
          },
  };
}

@Injectable()
export class TendersRepository implements OnModuleDestroy {
  private readonly db: Database.Database;

  constructor(config: ConfigService) {
    const dataDir = config.get<string>('DATA_DIR') ?? './data';
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, 'tenders.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenders (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        site          TEXT NOT NULL,
        external_id   TEXT NOT NULL,
        title         TEXT NOT NULL,
        buyer         TEXT,
        description   TEXT,
        url           TEXT,
        published_at  TEXT,
        deadline_at   TEXT,
        cpv_codes     TEXT,
        region        TEXT,
        contract_type TEXT,
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(site, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tenders_site ON tenders(site);
      CREATE INDEX IF NOT EXISTS idx_tenders_deadline ON tenders(deadline_at);

      -- Claude analysis, one row per analysed offer. Offers judged not
      -- relevant (or declined by Claude) keep only the outcome, so they are
      -- not sent again; details are stored for relevant offers only.
      CREATE TABLE IF NOT EXISTS tender_analyses (
        site             TEXT NOT NULL,
        external_id      TEXT NOT NULL,
        outcome          TEXT NOT NULL CHECK (outcome IN ('relevant', 'not_relevant', 'refused')),
        categories       TEXT,  -- JSON array
        summary          TEXT,
        skills           TEXT,  -- JSON array
        seniority        TEXT,
        duration         TEXT,
        start_date       TEXT,
        remote           TEXT,
        refusal_category TEXT,
        mission_text     TEXT,  -- contact details masked
        model            TEXT NOT NULL,
        analyzed_at      TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (site, external_id)
      );

      -- Offers whose analysis failed for a reason tied to the offer (no
      -- description, unusable answer). Past a few attempts they are set aside
      -- instead of being fetched and paid for on every run.
      CREATE TABLE IF NOT EXISTS tender_analysis_failures (
        site           TEXT NOT NULL,
        external_id    TEXT NOT NULL,
        attempts       INTEGER NOT NULL,
        last_error     TEXT NOT NULL,
        last_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (site, external_id)
      );

      -- Offers emailed to MyBestConsultant's AO inbox, recorded once the SMTP
      -- server accepted them: an offer is never sent twice.
      CREATE TABLE IF NOT EXISTS tender_ao_emails (
        site        TEXT NOT NULL,
        external_id TEXT NOT NULL,
        message_id  TEXT NOT NULL,
        sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (site, external_id)
      );

      -- Documents linked from a relevant offer's detail page (cahier des
      -- charges…): name and address only, never the content. They are
      -- downloaded again with the session when the offer is emailed (ADR 0007).
      CREATE TABLE IF NOT EXISTS tender_documents (
        site        TEXT NOT NULL,
        external_id TEXT NOT NULL,
        position    INTEGER NOT NULL,
        name        TEXT NOT NULL,
        url         TEXT NOT NULL,
        PRIMARY KEY (site, external_id, position)
      );

      -- Operator alerts in progress (expired session, Claude credits): when
      -- the last email was sent, so a reminder goes out at most once a day.
      -- The row is deleted once the problem is gone (ADR 0005).
      CREATE TABLE IF NOT EXISTS operator_alerts (
        kind         TEXT PRIMARY KEY,
        last_sent_at TEXT NOT NULL  -- ISO 8601
      );
    `);
  }

  /** When the alert of this kind was last emailed (ISO 8601), or null if it is not in progress. */
  alertLastSentAt(kind: string): string | null {
    const row = this.db.prepare('SELECT last_sent_at FROM operator_alerts WHERE kind = ?').get(kind) as
      | { last_sent_at: string }
      | undefined;
    return row?.last_sent_at ?? null;
  }

  markAlertSent(kind: string, sentAt: string): void {
    this.db
      .prepare(
        `INSERT INTO operator_alerts (kind, last_sent_at) VALUES (?, ?)
         ON CONFLICT(kind) DO UPDATE SET last_sent_at = excluded.last_sent_at`,
      )
      .run(kind, sentAt);
  }

  /** The problem is gone: the next occurrence is emailed at once. */
  clearAlert(kind: string): void {
    this.db.prepare('DELETE FROM operator_alerts WHERE kind = ?').run(kind);
  }

  /**
   * Relevant offers of `site` not emailed to the AO inbox yet whose deadline
   * has not passed at `now` (ISO 8601), most urgent first.
   */
  relevantNotEmailed(site: string, now: string, limit: number): TenderWithAnalysis[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, ${ANALYSIS_COLUMNS}
         FROM tenders t JOIN tender_analyses a ON a.site = t.site AND a.external_id = t.external_id
         WHERE t.site = @site AND a.outcome = 'relevant'
           AND NOT EXISTS (SELECT 1 FROM tender_ao_emails e WHERE e.site = t.site AND e.external_id = t.external_id)
           AND (t.deadline_at IS NULL OR t.deadline_at > @now)
         ORDER BY t.deadline_at IS NULL, t.deadline_at ASC
         LIMIT @limit`,
      )
      .all({ site, now, limit }) as (TenderRow & AnalysisColumns)[];
    return rows.map(withAnalysis);
  }

  markEmailed(site: string, externalId: string, messageId: string): void {
    this.db
      .prepare(
        `INSERT INTO tender_ao_emails (site, external_id, message_id) VALUES (?, ?, ?)
         ON CONFLICT(site, external_id) DO NOTHING`,
      )
      .run(site, externalId, messageId);
  }

  /**
   * External ids, among the given ones, still to analyse: no stored analysis
   * and fewer than `maxAttempts` recorded failures.
   */
  withoutAnalysis(site: string, externalIds: string[], maxAttempts: number): string[] {
    const done = new Set(
      (
        this.db
          .prepare(
            `SELECT external_id FROM tender_analyses WHERE site = @site
             UNION SELECT external_id FROM tender_analysis_failures WHERE site = @site AND attempts >= @maxAttempts`,
          )
          .all({ site, maxAttempts }) as { external_id: string }[]
      ).map((row) => row.external_id),
    );
    return externalIds.filter((id) => !done.has(id));
  }

  /** Counts one more failed attempt for the offer and returns the total. */
  recordAnalysisFailure(site: string, externalId: string, error: string): number {
    const row = this.db
      .prepare(
        `INSERT INTO tender_analysis_failures (site, external_id, attempts, last_error, last_failed_at)
         VALUES (@site, @externalId, 1, @error, datetime('now'))
         ON CONFLICT(site, external_id) DO UPDATE SET
           attempts = attempts + 1, last_error = excluded.last_error, last_failed_at = excluded.last_failed_at
         RETURNING attempts`,
      )
      .get({ site, externalId, error: error.slice(0, 500) }) as { attempts: number };
    return row.attempts;
  }

  /**
   * Idempotent: analysing the same offer again replaces its previous analysis
   * and its document links. `documents` are kept for relevant offers only,
   * like the mission text.
   */
  saveAnalysis(
    site: string,
    externalId: string,
    outcome: AnalysisOutcome,
    model: string,
    missionText: string | null,
    documents: DocumentLink[],
  ): void {
    const analysis = outcome.kind === 'relevant' ? outcome.analysis : null;
    const clearFailures = this.db.prepare('DELETE FROM tender_analysis_failures WHERE site = ? AND external_id = ?');
    const clearDocuments = this.db.prepare('DELETE FROM tender_documents WHERE site = ? AND external_id = ?');
    const insertDocument = this.db.prepare(
      'INSERT INTO tender_documents (site, external_id, position, name, url) VALUES (?, ?, ?, ?, ?)',
    );
    const insert = this.db
      .prepare(
        `INSERT INTO tender_analyses (site, external_id, outcome, categories, summary, skills, seniority, duration,
                                      start_date, remote, refusal_category, mission_text, model, analyzed_at)
         VALUES (@site, @externalId, @outcome, @categories, @summary, @skills, @seniority, @duration,
                 @startDate, @remote, @refusalCategory, @missionText, @model, datetime('now'))
         ON CONFLICT(site, external_id) DO UPDATE SET
           outcome = excluded.outcome, categories = excluded.categories, summary = excluded.summary,
           skills = excluded.skills, seniority = excluded.seniority, duration = excluded.duration,
           start_date = excluded.start_date, remote = excluded.remote, refusal_category = excluded.refusal_category,
           mission_text = excluded.mission_text, model = excluded.model, analyzed_at = excluded.analyzed_at`,
      );
    const values = {
      site,
      externalId,
      outcome: outcome.kind,
      categories: analysis ? JSON.stringify(analysis.categories) : null,
      summary: analysis?.summary ?? null,
      skills: analysis ? JSON.stringify(analysis.skills) : null,
      seniority: analysis?.seniority ?? null,
      duration: analysis?.duration ?? null,
      startDate: analysis?.start_date ?? null,
      remote: analysis?.remote ?? null,
      refusalCategory: outcome.kind === 'refused' ? outcome.category : null,
      missionText: analysis ? missionText : null,
      model,
    };
    this.db.transaction(() => {
      insert.run(values);
      clearFailures.run(site, externalId);
      clearDocuments.run(site, externalId);
      if (analysis) documents.forEach((document, position) => insertDocument.run(site, externalId, position, document.name, document.url));
    })();
  }

  /** Documents of an analysed offer, in the order of its page. */
  documentLinks(site: string, externalId: string): DocumentLink[] {
    return this.db
      .prepare('SELECT name, url FROM tender_documents WHERE site = ? AND external_id = ? ORDER BY position')
      .all(site, externalId) as DocumentLink[];
  }

  /** Insert new tenders, refresh last_seen_at for known ones. Returns ids of new rows. */
  upsertMany(tenders: Tender[]): string[] {
    const stmt = this.db.prepare(`
      INSERT INTO tenders (site, external_id, title, buyer, description, url,
                           published_at, deadline_at, cpv_codes, region, contract_type)
      VALUES (@site, @externalId, @title, @buyer, @description, @url,
              @publishedAt, @deadlineAt, @cpvCodes, @region, @contractType)
      ON CONFLICT(site, external_id) DO UPDATE SET
        title = excluded.title,
        url = excluded.url,
        deadline_at = excluded.deadline_at,
        last_seen_at = datetime('now')
    `);
    const exists = this.db.prepare('SELECT 1 FROM tenders WHERE site = ? AND external_id = ?');

    const newIds: string[] = [];
    const tx = this.db.transaction((rows: Tender[]) => {
      for (const t of rows) {
        const already = exists.get(t.site, t.externalId);
        stmt.run({
          site: t.site,
          externalId: t.externalId,
          title: t.title.slice(0, 500),
          buyer: t.buyer ?? null,
          description: t.description ?? null,
          url: t.url,
          publishedAt: t.publishedAt ?? null,
          deadlineAt: t.deadlineAt ?? null,
          cpvCodes: t.cpvCodes?.join(',') ?? null,
          region: t.region ?? null,
          contractType: t.contractType ?? null,
        });
        if (!already) newIds.push(`${t.site}:${t.externalId}`);
      }
    });
    tx(tenders);
    return newIds;
  }

  find(query: {
    site?: string;
    q?: string;
    since?: string; // ISO date — filters on first_seen_at (new tenders)
    deadlineBefore?: string;
    /** true: only offers Claude matched to a category; false: all others. */
    relevant?: boolean;
    limit?: number;
    offset?: number;
  }): { total: number; rows: TenderWithAnalysis[] } {
    const where: string[] = [];
    const params: Record<string, string | number> = {};

    if (query.site) { where.push('t.site = @site'); params.site = query.site; }
    if (query.q) { where.push('(t.title LIKE @q OR t.buyer LIKE @q OR t.description LIKE @q)'); params.q = `%${query.q}%`; }
    if (query.since) { where.push("t.first_seen_at >= @since"); params.since = query.since; }
    if (query.deadlineBefore) { where.push('t.deadline_at IS NOT NULL AND t.deadline_at <= @deadlineBefore'); params.deadlineBefore = query.deadlineBefore; }
    if (query.relevant === true) where.push("a.outcome = 'relevant'");
    if (query.relevant === false) where.push("(a.outcome IS NULL OR a.outcome <> 'relevant')");

    const fromSql = 'FROM tenders t LEFT JOIN tender_analyses a ON a.site = t.site AND a.external_id = t.external_id';
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS c ${fromSql} ${whereSql}`).get(params) as { c: number }).c;
    params.limit = query.limit ?? 50;
    params.offset = query.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT t.*, ${ANALYSIS_COLUMNS} ${fromSql} ${whereSql}
         ORDER BY COALESCE(t.deadline_at, t.published_at, t.first_seen_at) DESC LIMIT @limit OFFSET @offset`,
      )
      .all(params) as (TenderRow & AnalysisColumns)[];
    return { total, rows: rows.map(withAnalysis) };
  }

  stats(): { total: number; bySite: { site: string; count: number }[] } {
    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM tenders').get() as { c: number }).c;
    const bySite = this.db.prepare('SELECT site, COUNT(*) AS count FROM tenders GROUP BY site').all() as { site: string; count: number }[];
    return { total, bySite };
  }

  onModuleDestroy(): void {
    this.db.close();
  }
}
