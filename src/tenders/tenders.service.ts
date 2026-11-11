import { Injectable } from '@nestjs/common';
import { Tender } from '../scrapers/tender.types';
import { TendersRepository, TenderRow } from './tenders.repository';

@Injectable()
export class TendersService {
  constructor(private readonly repository: TendersRepository) {}

  async ingest(tenders: Tender[]): Promise<{ stored: number; newCount: number }> {
    if (tenders.length === 0) return { stored: 0, newCount: 0 };
    const newIds = this.repository.upsertMany(tenders);
    return { stored: tenders.length, newCount: newIds.length };
  }

  find(query: {
    site?: string;
    q?: string;
    since?: string;
    deadlineBefore?: string;
    limit?: number;
    offset?: number;
  }): { total: number; rows: TenderRow[] } {
    return this.repository.find(query);
  }

  stats(): { total: number; bySite: { site: string; count: number }[] } {
    return this.repository.stats();
  }
}
