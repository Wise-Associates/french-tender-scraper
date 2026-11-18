import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { Tender } from '../scrapers/tender.types';
import { AnalyzerUnavailableError } from './model-analysis';
import { DEFAULT_OPENAI_MODEL, OpenAiAnalyzer } from './openai-analyzer.service';

// Fictitious offer and key; fetch is replaced, nothing leaves the machine.
const FAKE_KEY = 'sk-test-not-a-real-key';
const tender: Tender = {
  site: 'partenaire-gc',
  externalId: 'acme-data-engineer',
  title: 'Data engineer',
  buyer: 'ACME BANQUE',
  url: 'https://partenaire-gc.com/consultations/acme-data-engineer',
};
const answer = {
  categories: ['data_ia'],
  summary: 'Mission data.',
  skills: ['Python'],
  seniority: null,
  duration: null,
  start_date: null,
  remote: null,
};

function analyzer(env: Record<string, string | undefined> = { OPENAI_API_KEY: FAKE_KEY }): OpenAiAnalyzer {
  return new OpenAiAnalyzer({ get: (key: string) => env[key] } as ConfigService);
}

function respond(status: number, body: unknown) {
  return mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status }));
}

describe('OpenAiAnalyzer', () => {
  afterEach(() => mock.restoreAll());

  it('is disabled without OPENAI_API_KEY and uses the default model unless OPENAI_MODEL is set', () => {
    assert.equal(analyzer({}).enabled, false);
    assert.equal(analyzer({ OPENAI_API_KEY: '  ' }).enabled, false);
    assert.equal(analyzer().model, DEFAULT_OPENAI_MODEL);
    assert.equal(analyzer({ OPENAI_API_KEY: FAKE_KEY, OPENAI_MODEL: 'gpt-other' }).model, 'gpt-other');
  });

  it('refuses at startup a key that fetch would quote in its error', () => {
    for (const bad of ['sk-test-part1\nsk-test-part2', 'sk-test with-space', 'sk-test-é']) {
      assert.throws(() => analyzer({ OPENAI_API_KEY: bad }), (err: Error) => /OPENAI_API_KEY contains/.test(err.message) && !err.message.includes('sk-test'));
    }
  });

  it('sends the masked offer with a strict JSON schema, not stored by OpenAI', async () => {
    const fetchMock = respond(200, {
      model: 'gpt-6-luna-2026-09-22',
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer), refusal: null } }],
      usage: { prompt_tokens: 900, completion_tokens: 120 },
    });
    const result = await analyzer().analyze(tender, 'Contact : rh@acme.test — pipeline Python');

    assert.deepEqual(result, {
      result: { kind: 'relevant', analysis: answer },
      model: 'gpt-6-luna-2026-09-22',
      inputTokens: 900,
      outputTokens: 120,
    });
    const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${FAKE_KEY}`);
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, DEFAULT_OPENAI_MODEL);
    assert.equal(body.store, false);
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    assert.equal(body.response_format.json_schema.schema.$schema, undefined);
    assert.deepEqual(body.response_format.json_schema.schema.required, Object.keys(answer));
    assert.match(body.messages[1].content, /\[email masqué\]/);
    assert.doesNotMatch(body.messages[1].content, /rh@acme\.test/);
  });

  it('stops the batch on a rejected request, without echoing the key', async () => {
    respond(401, { error: { message: `Incorrect API key provided: ${FAKE_KEY}`, code: 'invalid_api_key' } });
    await assert.rejects(analyzer().analyze(tender, 'Python'), (err: Error) => {
      return err instanceof AnalyzerUnavailableError && /401/.test(err.message) && !err.message.includes(FAKE_KEY);
    });

    mock.restoreAll();
    respond(429, { error: { message: 'You exceeded your current quota.', code: 'insufficient_quota' } });
    await assert.rejects(analyzer().analyze(tender, 'Python'), (err: Error) => {
      return err instanceof AnalyzerUnavailableError && /429: insufficient_quota You exceeded/.test(err.message);
    });
  });

  it('reports server errors and odd answers as ordinary errors (retried next run)', async () => {
    respond(503, { error: { message: 'Service unavailable' } });
    await assert.rejects(analyzer().analyze(tender, 'Python'), (err: Error) => !(err instanceof AnalyzerUnavailableError) && /503/.test(err.message));

    mock.restoreAll();
    respond(200, { unexpected: true });
    await assert.rejects(analyzer().analyze(tender, 'Python'), /unexpected response shape/);
  });

  it('treats a timeout as an ordinary API error, not a rejected request', async () => {
    mock.method(globalThis, 'fetch', async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await assert.rejects(analyzer().analyze(tender, 'Python'), (err: Error) => !(err instanceof AnalyzerUnavailableError) && err.name === 'TimeoutError');
  });

  it('refuses to call the API without a key', async () => {
    await assert.rejects(analyzer({}).analyze(tender, 'Python'), AnalyzerUnavailableError);
  });
});
