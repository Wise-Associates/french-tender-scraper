export const SITE_KEYS = [
  'maximilien',
  'aw-solutions',
  'achatpublic',
  'emarchespublics',
  'bpifrance',
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
}
