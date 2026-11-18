import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Tender } from '../scrapers/tender.types';
import { AnalyzerUnavailableError, ClaudeOutOfCreditsError, ModelAnalysis } from './model-analysis';
import { ANALYSIS_SYSTEM_PROMPT, buildOfferPrompt, interpretResponse, OfferAnalysisSchema } from './offer-analysis';

/** Chosen by Wise Associates (November 2026). Changing it: re-check `fallbacks` support for the new model. */
export const ANALYSIS_MODEL = 'claude-sonnet-5-5';

/** The fields of an Anthropic API error that tell a credit problem apart (SDK `APIError`). */
export interface ClaudeApiErrorFields {
  status: number | undefined;
  type: string | null;
  errorCode: string | null;
  apiMessage: string | null;
}

/**
 * A refusal that lasts until someone acts on the Anthropic account
 * (platform.claude.com/docs/en/api/errors and /api/rate-limits, Nov. 2026):
 * - 402 `billing_error`: billing or payment problem;
 * - 429 with error_code `enforced_spend_limit_reached`: the usage tier's monthly cap;
 * - 400 `invalid_request_error` for a spend limit set in the Console, or an
 *   empty prepaid balance. These two have no error code, so their documented
 *   wording is the only signal. If Anthropic rewords them, the error is no
 *   longer recognised: the batch stops as for any rejected request, and the
 *   offers wait for the next run (nothing is lost, there is just no fallback).
 */
export function isClaudeCreditProblem(err: ClaudeApiErrorFields): boolean {
  if (err.status === 402 || err.type === 'billing_error') return true;
  if (err.errorCode === 'enforced_spend_limit_reached') return true;
  return (
    err.status === 400 &&
    err.type === 'invalid_request_error' &&
    /credit balance is too low|reached your specified (workspace )?API usage limits/i.test(err.apiMessage ?? '')
  );
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

  async analyze(tender: Tender, missionText: string): Promise<ModelAnalysis> {
    if (!this.client) throw new AnalyzerUnavailableError('ANTHROPIC_API_KEY is not set');
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
      // Checked first: a 402 has no dedicated SDK class and a spend-cap 429 is a RateLimitError.
      if (err instanceof Anthropic.APIError && isClaudeCreditProblem(err)) {
        throw new ClaudeOutOfCreditsError(`Claude API ${err.status} (${err.errorCode ?? err.type}): ${err.apiMessage ?? err.message}`);
      }
      if (
        err instanceof Anthropic.BadRequestError ||
        err instanceof Anthropic.AuthenticationError ||
        err instanceof Anthropic.PermissionDeniedError ||
        err instanceof Anthropic.NotFoundError ||
        err instanceof Anthropic.RateLimitError
      ) {
        throw new AnalyzerUnavailableError(`Claude API ${err.status}: ${err.message}`);
      }
      throw err;
    }
  }
}
