# ADR 0004 — OpenAI fallback when Claude has a credit problem

- Status: accepted
- Date: 2026-11-18

## Context

Partenaire GC offers are classified by Claude (ADR 0001). When the Anthropic
account runs out of prepaid credits, hits a spend limit or has a billing
problem, every request is refused until someone acts on the account. Until
now the batch then stopped and new offers waited, sometimes for days, which
delays answers to time-limited consultations. Wise Associates asked for a
cheap GPT model to take over in that case only.

## Decision

- **Trigger: credit problems only.** A Claude refusal counts as one when the
  API returns a 402 `billing_error`, a 429 with error code
  `enforced_spend_limit_reached` (usage tier's monthly cap), or a 400
  `invalid_request_error` whose message is the documented "credit balance is
  too low" / "reached your specified (workspace) API usage limits"
  (`isClaudeCreditProblem`, `src/analysis/claude-analyzer.service.ts`).
  Other errors (invalid key, bad request, outages) keep their previous
  handling: a wrong setting must not quietly move all traffic to OpenAI.
- **Scope: the rest of the run.** Once Claude reports a credit problem, the
  offer and all later ones of that run go to OpenAI, without retrying Claude
  for each offer. The next run tries Claude first again, so topping up the
  credits is enough to come back.
- **Model:** `gpt-6-luna` by default ($0.10 / $0.50 per million input /
  output tokens, the cheapest GPT model in November 2026 and OpenAI's named
  replacement for gpt-4o-mini, which shuts down on 2027-01-14).
  `OPENAI_MODEL` overrides it.
- **Same rules as Claude:** same system prompt, categories and masked offer
  text; the answer is constrained by the same zod schema (Structured
  Outputs, `strict: true`) and re-validated; refusals, filtered and
  truncated answers follow ADR 0001's rules. The model that answered is
  stored with each analysis. `ANALYSIS_MAX_PER_RUN` caps Claude and OpenAI
  calls together.
- **No new dependency:** one `fetch` call to the Chat Completions API (120 s
  timeout, no retry: a server error leaves the offer for the next run, and 3
  in a row stop the batch). Rejected requests (key, quota, model) stop the
  batch like Claude's. `store: false` so OpenAI does not keep the
  completions.
- **Not silent:** the run result reports `claudeCreditProblem` and
  `fallback: { model, answers }`, the log has an error line, and the operator is
  emailed (ADR 0005).

## Alternatives considered

- **gpt-4o-mini** (the model first suggested): shuts down two months after
  this decision, and costs more ($0.15 / $0.60).
- **Fall back on any Claude error**: keeps offers flowing during outages too,
  but outages are short and already retried on the next run, while a
  configuration error would be hidden behind a working fallback.
- **The official `openai` SDK**: retries and typed errors, but a new
  dependency for one request.

## Consequences

- During a credit problem, each new offer's masked description is sent to
  OpenAI instead of Anthropic: a second processor of Partenaire GC's content,
  to be covered like the first (ADR 0001). Check OpenAI's API data retention
  terms for the organisation that owns the key.
- Classification quality may differ slightly from Claude's on borderline
  offers analysed during the fallback; their `model` column tells them
  apart, and they can be re-analysed by deleting their `tender_analyses` rows.
- The 400 cases are recognised by their wording, which Anthropic may change:
  the fallback would then not trigger, and the batch stops as before.
- `inputTokens` / `outputTokens` in the run result add both providers' tokens.
