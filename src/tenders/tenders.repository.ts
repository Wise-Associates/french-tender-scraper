import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';
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
    `);
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
    limit?: number;
    offset?: number;
  }): { total: number; rows: TenderRow[] } {
    const where: string[] = [];
    const params: Record<string, string | number> = {};

    if (query.site) { where.push('site = @site'); params.site = query.site; }
    if (query.q) { where.push('(title LIKE @q OR buyer LIKE @q OR description LIKE @q)'); params.q = `%${query.q}%`; }
    if (query.since) { where.push("first_seen_at >= @since"); params.since = query.since; }
    if (query.deadlineBefore) { where.push('deadline_at IS NOT NULL AND deadline_at <= @deadlineBefore'); params.deadlineBefore = query.deadlineBefore; }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM tenders ${whereSql}`).get(params) as { c: number }).c;
    params.limit = query.limit ?? 50;
    params.offset = query.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM tenders ${whereSql} ORDER BY COALESCE(deadline_at, published_at, first_seen_at) DESC LIMIT @limit OFFSET @offset`)
      .all(params) as TenderRow[];
    return { total, rows };
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
