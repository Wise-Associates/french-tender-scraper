import { AnalysisResult } from './offer-analysis';

/** One offer classified by a model (Claude, or the OpenAI fallback). */
export interface ModelAnalysis {
  result: AnalysisResult;
  /** The model that answered, stored with the analysis. */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The request itself is rejected (invalid key, no access, bad parameter,
 * unknown model, rate limit after retries): the same would happen for every
 * offer, so the batch stops. Not the offer's fault — no attempt is counted.
 */
export class AnalyzerUnavailableError extends Error {}

/**
 * Claude refuses requests until someone acts on the account: credits
 * exhausted, billing problem or spend limit reached. The OpenAI fallback takes
 * over for the rest of the run when it is configured (ADR 0004).
 */
export class ClaudeOutOfCreditsError extends AnalyzerUnavailableError {}
