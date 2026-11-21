import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { DocumentText } from '../documents/offer-documents';
import { Tender } from '../scrapers/tender.types';
import { AnalyzerUnavailableError, ModelAnalysis } from './model-analysis';
import { ANALYSIS_SYSTEM_PROMPT, buildOfferPrompt, interpretOpenAiResponse, OfferAnalysisSchema } from './offer-analysis';

/**
 * Cheapest current GPT model in November 2026 ($0.10 / $0.50 per million
 * input / output tokens) and OpenAI's named replacement for gpt-4o-mini, which
 * shuts down on 2027-01-14. OPENAI_MODEL overrides it; any model supporting
 * Structured Outputs (json_schema) works, since no model-specific parameter is sent.
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';

const CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const TIMEOUT_MS = 120_000;

/** The answer is checked before use: it comes from outside. Extra fields are ignored. */
const CompletionSchema = z.object({
  model: z.string(),
  choices: z.array(
    z.object({
      finish_reason: z.string().nullable(),
      message: z.object({ content: z.string().nullish(), refusal: z.string().nullish() }),
    }),
  ),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }),
});

/** OpenAI's strict mode needs every field required and no extra properties, which the zod schema already says. */
const RESPONSE_FORMAT = (() => {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(OfferAnalysisSchema);
  return { type: 'json_schema', json_schema: { name: 'offer_analysis', strict: true, schema } } as const;
})();

/**
 * Errors that would repeat for every offer (key, access, model, request,
 * quota or rate limit) stop the batch, like Claude's; server errors are left
 * to the caller's "3 API errors in a row" rule. The message never contains
 * the key: OpenAI's 401 text quotes part of it, so it is not reused.
 */
export function openAiError(status: number, body: unknown): Error {
  const parsed = z.object({ error: z.object({ message: z.string().optional(), code: z.string().nullish() }) }).safeParse(body);
  const detail = parsed.success ? `${parsed.data.error.code ?? ''} ${parsed.data.error.message ?? ''}`.trim().slice(0, 300) : '';
  if (status === 401) {
    // Seen in practice: the masked key copied from the dashboard list ("sk-proj-…abcd") instead of the full one.
    return new AnalyzerUnavailableError(
      'OpenAI API 401: OPENAI_API_KEY refused. Use the full key (starts with "sk-", no "...", shown only once ' +
        'when created): create a new one if needed.',
    );
  }
  const message = `OpenAI API ${status}${detail ? `: ${detail}` : ''}`;
  return status >= 400 && status < 500 ? new AnalyzerUnavailableError(message) : new Error(message);
}

/**
 * Fallback classifier, used only while Claude refuses requests for a credit
 * problem (ADR 0004). Same prompt, categories and checks as Claude.
 */
@Injectable()
export class OpenAiAnalyzer {
  private readonly apiKey?: string;
  readonly model: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('OPENAI_API_KEY')?.trim() || undefined;
    // Checked at startup: fetch() quotes an invalid header value (line break…)
    // in its error, which would put the key in the logs and the run results.
    if (apiKey !== undefined && !/^[\x21-\x7E]+$/.test(apiKey)) {
      throw new Error('OPENAI_API_KEY contains a space, a line break or a non-ASCII character: paste the key again');
    }
    this.apiKey = apiKey;
    this.model = config.get<string>('OPENAI_MODEL')?.trim() || DEFAULT_OPENAI_MODEL;
  }

  get enabled(): boolean {
    return this.apiKey !== undefined;
  }

  async analyze(tender: Tender, missionText: string, documents: DocumentText[] = []): Promise<ModelAnalysis> {
    if (!this.apiKey) throw new AnalyzerUnavailableError('OPENAI_API_KEY is not set');
    const response = await fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
          { role: 'user', content: buildOfferPrompt(tender, missionText, documents) },
        ],
        response_format: RESPONSE_FORMAT,
        // Covers the reasoning tokens of reasoning models plus the short JSON answer (same budget as Claude).
        max_completion_tokens: 8_000,
        // Offer texts are paid content: do not keep them in OpenAI's stored completions.
        store: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw openAiError(response.status, body);

    const completion = CompletionSchema.safeParse(body);
    if (!completion.success) throw new Error('OpenAI API: unexpected response shape');
    return {
      result: interpretOpenAiResponse(completion.data),
      model: completion.data.model,
      inputTokens: completion.data.usage.prompt_tokens,
      outputTokens: completion.data.usage.completion_tokens,
    };
  }
}
