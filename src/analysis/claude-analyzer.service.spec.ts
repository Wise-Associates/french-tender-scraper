import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClaudeApiErrorFields, isClaudeCreditProblem } from './claude-analyzer.service';

// Error bodies as documented by Anthropic (platform.claude.com/docs/en/api/errors and /api/rate-limits).
const error = (fields: Partial<ClaudeApiErrorFields>): ClaudeApiErrorFields => ({
  status: 400,
  type: 'invalid_request_error',
  errorCode: null,
  apiMessage: null,
  ...fields,
});

describe('isClaudeCreditProblem', () => {
  it('recognises a billing error', () => {
    assert.equal(isClaudeCreditProblem(error({ status: 402, type: 'billing_error' })), true);
  });

  it("recognises the usage tier's monthly spend cap, but not an ordinary rate limit", () => {
    assert.equal(isClaudeCreditProblem(error({ status: 429, type: 'rate_limit_error', errorCode: 'enforced_spend_limit_reached' })), true);
    assert.equal(isClaudeCreditProblem(error({ status: 429, type: 'rate_limit_error' })), false);
    assert.equal(isClaudeCreditProblem(error({ status: 429, type: 'rate_limit_error', errorCode: 'ramp_limit_exceeded' })), false);
  });

  it('recognises an empty credit balance and a spend limit set in the Console', () => {
    for (const apiMessage of [
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.',
      'You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.',
    ]) {
      assert.equal(isClaudeCreditProblem(error({ apiMessage })), true, apiMessage);
    }
  });

  it('leaves other request errors alone', () => {
    assert.equal(isClaudeCreditProblem(error({ apiMessage: 'max_tokens: Field required' })), false);
    assert.equal(isClaudeCreditProblem(error({ status: 401, type: 'authentication_error', apiMessage: 'invalid x-api-key' })), false);
    assert.equal(isClaudeCreditProblem(error({ status: 500, type: 'api_error', apiMessage: 'credit balance is too low' })), false);
  });
});
