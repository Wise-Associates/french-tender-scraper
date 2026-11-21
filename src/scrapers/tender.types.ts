import { DocumentText } from '../documents/offer-documents';

export const SITE_KEYS = [
  'maximilien',
  'aw-solutions',
  'achatpublic',
  'emarchespublics',
  'bpifrance',
  'partenaire-gc',
] as const;

export type SiteKey = (typeof SITE_KEYS)[number];

export interface Tender {
  site: SiteKey;
  externalId: string;
  title: string;
  buyer?: string;
  description?: string;
  url: string;
  publishedAt?: string; // ISO 8601
  deadlineAt?: string; // ISO 8601
  cpvCodes?: string[];
  region?: string;
  contractType?: string;
  raw?: Record<string, unknown>;
}

export interface ScrapeFilters {
  keywords?: string[];
  maxResults?: number;
}

export interface ScrapeResult {
  site: SiteKey;
  scrapedAt: string;
  durationMs: number;
  count: number;
  newCount: number;
  error?: string;
  /** Claude analysis of this run's offers, for sites that provide detail pages. */
  analysis?: AnalysisSummary;
  /** Relevant offers emailed to the AO inbox after this run (sites with analysis only). */
  aoEmails?: { sent: number; refused: number; error?: string };
}

/**
 * The mission text read from an offer's detail page, with the text of its
 * documents (cahier des charges…, ADR 0007), or why it could not be read.
 * `offerProblem`: the page itself is unusable (no description, foreign URL…)
 * and counts as a failed attempt for the offer; otherwise (network, site
 * down) it does not.
 */
export type OfferDetails =
  | { tender: Tender; text: string; documents: DocumentText[] }
  | { tender: Tender; error: string; offerProblem: boolean };

export interface AnalysisSummary {
  analyzed: number;
  relevant: number;
  notRelevant: number;
  refused: number;
  /** Offers with no IT keyword, set aside without calling Claude (analysis/it-keywords.ts). */
  filteredOut: number;
  /** Offers whose details or analysis failed this run; retried on the next run unless abandoned. */
  failed: number;
  /** Offers set aside this run after repeated failures (see tender_analysis_failures). */
  abandoned: number;
  /** Offers left for the next run (detail pages or Claude calls over this run's limits, batch stopped). */
  remaining: number;
  /** Claude's and the OpenAI fallback's tokens added together (their prices differ). */
  inputTokens: number;
  outputTokens: number;
  /** Claude refused a request for lack of credits (or billing, spend limit) this run: its message. */
  claudeCreditProblem?: string;
  /**
   * Set when the OpenAI fallback was tried this run, after Claude's credit
   * problem (ADR 0004): `answers` counts the answers it gave (0: it failed too).
   */
  fallback?: { model: string; answers: number };
  /** Why the analysis stopped before the end of the batch, or was not run. */
  error?: string;
}
