# ADR 0001 — Classify Partenaire GC offers with Claude

- Status: accepted
- Date: 2026-11-12

## Context

The Partenaire GC subscriber area lists 30–50 open consulting missions at a
time, most of them outside Wise Associates' fields. The listing shows only a
short profile name ("PMO Niveau 1", "Expert Méthodes"); what the mission
really is lives in the free-text description of each detail page. Keyword
matching on that text misclassifies too much (e.g. "sécurité" in a software
offer, "data" in an infrastructure one).

## Decision

- After each scrape, the detail page of every offer **not analysed yet** is
  read and sent once to the Claude API (`claude-sonnet-5-5`, effort `low`,
  structured output validated with zod). Claude returns the matching
  categories — software development & SaaS, IT steering & agile, data & AI —
  and the key details (summary, skills, seniority, duration, start, remote).
- Results go to a separate `tender_analyses` table (additive, no change to
  `tenders`). Details are stored for **relevant offers only**; other offers
  keep just their outcome so they are never sent again. Refusals are stored
  once.
- Failures tied to the offer (no description, truncated or invalid answer)
  are counted in `tender_analysis_failures`; after 3 attempts the offer is set
  aside, so a bad offer cannot be fetched and paid for on every run. Outages
  (site or API down) count nothing; a rejected request or 3 API errors in a
  row stop the batch.
- The response is read with `messages.create` and validated by our code, not
  `messages.parse`: `parse` validates every text block before the stop reason
  can be checked (a refusal with partial text would look like a failure) and
  loses the token usage of billed calls that fail.
- Emails and phone numbers are masked before sending, in storage and in
  Claude's answers. The API key is read from `ANTHROPIC_API_KEY` on the server
  only.
- Server-side refusal fallback (`fallbacks: "default"`) is enabled; the model
  that actually answered is stored.

## Alternatives considered

- **Keyword rules** — free and deterministic, but poor on the free-text
  descriptions; rejected.
- **Claude Opus 5.5** — more accurate on borderline offers, about twice the
  price of Sonnet 5.5; **Claude Haiku 5.5** — far cheaper, less reliable on
  mixed offers. Sonnet 5.5 was chosen by Wise Associates as the balance.
- **Store details for every offer** — more transparency on Claude's choices,
  but keeps paid content Wise Associates does not need; rejected by Wise
  Associates.

## Consequences

- Each new offer's description is sent to Anthropic's API. Partenaire GC's
  legal notice restricts reproduction of its content; this use must be covered
  by Wise Associates' agreement with Partenaire GC.
- Cost is per new offer only (about a cent each at November 2026 prices);
  every run reports the tokens used.
- Changing the categories does not re-analyse existing offers: delete their
  rows from `tender_analyses` to have them analysed again.
- Changing the model requires checking that it supports the `fallbacks`
  parameter (Claude Haiku 5.5 has no server-side fallback).
- Person names in offer texts are not detected, so they are sent and stored
  as they appear (contact details are not).
- The scraper's API has no authentication and now serves the stored mission
  texts: it must stay reachable from the operator's machine only.
