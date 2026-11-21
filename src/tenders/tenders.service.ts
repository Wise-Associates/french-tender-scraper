import { Injectable } from '@nestjs/common';
import { AnalysisOutcome } from '../analysis/offer-analysis';
import { DocumentLink } from '../documents/offer-documents';
import { Tender } from '../scrapers/tender.types';
import { TendersRepository, TenderWithAnalysis } from './tenders.repository';

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
    relevant?: boolean;
    limit?: number;
    offset?: number;
  }): { total: number; rows: TenderWithAnalysis[] } {
    return this.repository.find(query);
  }

  /** The given offers still to analyse: not analysed yet and fewer than `maxAttempts` failures. */
  withoutAnalysis(site: string, tenders: Tender[], maxAttempts: number): Tender[] {
    const pending = new Set(this.repository.withoutAnalysis(site, tenders.map((t) => t.externalId), maxAttempts));
    return tenders.filter((t) => pending.has(t.externalId));
  }

  /** Records a failed attempt tied to the offer; returns how many it has had. */
  recordAnalysisFailure(tender: Tender, error: string): number {
    return this.repository.recordAnalysisFailure(tender.site, tender.externalId, error);
  }

  saveAnalysis(tender: Tender, outcome: AnalysisOutcome, model: string, missionText: string | null, documents: DocumentLink[]): void {
    this.repository.saveAnalysis(tender.site, tender.externalId, outcome, model, missionText, documents);
  }

  stats(): { total: number; bySite: { site: string; count: number }[] } {
    return this.repository.stats();
  }
}
