import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Tender } from '../scrapers/tender.types';
import {
  ANALYSIS_SYSTEM_PROMPT,
  AnalysisResult,
  buildOfferPrompt,
  interpretResponse,
  OfferAnalysisSchema,
} from './offer-analysis';

/** Chosen by Wise Associates (November 2026). Changing it: re-check `fallbacks` support for the new model. */
export const ANALYSIS_MODEL = 'claude-sonnet-5-5';

/**
 * The request itself is rejected (invalid key, no access, bad parameter,
 * unknown model, rate limit after retries): the same would happen for every
 * offer, so the batch stops. Not the offer's fault — no attempt is counted.
 */
export class ClaudeUnavailableError extends Error {}

export interface ClaudeAnalysis {
  result: AnalysisResult;
  /** The model that answered (differs from ANALYSIS_MODEL after a fallback). */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Sends one offer to Claude and returns its classification and extracted details. */
@Injectable()
export class ClaudeAnalyzer {
  private readonly client?: Anthropic;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    // Per-attempt timeout; the SDK itself retries 408/409/429/5xx and
    // connection errors twice with backoff before an error reaches us.
    if (apiKey) this.client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
  }

  get enabled(): boolean {
    return this.client !== undefined;
  }

  async analyze(tender: Tender, missionText: string): Promise<ClaudeAnalysis> {
    if (!this.client) throw new ClaudeUnavailableError('ANTHROPIC_API_KEY is not set');
    try {
      // create(), not parse(): parse() validates every text block before the
      // stop reason can be checked, and throws away the usage of a billed call.
      const response = await this.client.beta.messages.create({
        model: ANALYSIS_MODEL,
        // Thinking counts toward max_tokens; the JSON answer itself is short.
        max_tokens: 8_000,
        // Classification needs little reasoning: low effort keeps cost and latency down.
        output_config: { effort: 'low', format: betaZodOutputFormat(OfferAnalysisSchema) },
        // On a policy decline, the API re-runs the request on a suitable model in the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: ANALYSIS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildOfferPrompt(tender, missionText) }],
      });
      return {
        result: interpretResponse(response),
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (err) {
      if (
        err instanceof Anthropic.BadRequestError ||
        err instanceof Anthropic.AuthenticationError ||
        err instanceof Anthropic.PermissionDeniedError ||
        err instanceof Anthropic.NotFoundError ||
        err instanceof Anthropic.RateLimitError
      ) {
        throw new ClaudeUnavailableError(`Claude API ${err.status}: ${err.message}`);
      }
      throw err;
    }
  }
}
