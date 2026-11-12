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
}

/**
 * The mission text read from an offer's detail page, or why it could not be
 * read. `offerProblem`: the page itself is unusable (no description, foreign
 * URL…) and counts as a failed attempt for the offer; otherwise (network,
 * site down) it does not.
 */
export type OfferDetails =
  | { tender: Tender; text: string }
  | { tender: Tender; error: string; offerProblem: boolean };

export interface AnalysisSummary {
  analyzed: number;
  relevant: number;
  notRelevant: number;
  refused: number;
  /** Offers whose details or analysis failed this run; retried on the next run unless abandoned. */
  failed: number;
  /** Offers set aside this run after repeated failures (see tender_analysis_failures). */
  abandoned: number;
  /** Offers left for the next run because of ANALYSIS_MAX_PER_RUN. */
  remaining: number;
  inputTokens: number;
  outputTokens: number;
  /** Why the analysis stopped before the end of the batch, or was not run. */
  error?: string;
}
