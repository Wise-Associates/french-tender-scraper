# ADR 0005 — Email the operator when the scraper needs a person

- Status: accepted
- Date: 2026-11-18

## Context

On the VPS, runs are scheduled and nobody reads the logs. Two problems stop
the useful work until a person acts:

- the Partenaire GC session expires (about every 3 weeks); only a manual
  login renews it (anti-bot check, see the README);
- Claude refuses requests for a credit problem; with the OpenAI fallback
  (ADR 0004) offers keep being analysed, but someone still has to top up.

Until now both were visible only in the run results and container logs.

## Decision

- An alert email goes to `ALERTS_TO` (one address, validated at startup;
  empty disables the emails, which are then only logged) with the
  `SMTP_*` / `MAIL_FROM` settings of the AO sending, without its
  same-domain rule.
- **When:** a run that hits the expired session (`SessionMissingError`, while
  reading the listing or the detail pages), or whose analysis met a Claude
  credit problem. The first occurrence is emailed at once, then at most one
  reminder every 20 hours while the problem lasts: once a day at the same
  scheduled run, even if runs start a few minutes late.
- **Reset:** a run that reads the site's listing clears its session alert; a
  run where Claude answered without credit problem clears the credits alert.
  The next occurrence is then emailed at once.
- **State:** `operator_alerts` table (kind, last email time) in the scraper's
  SQLite database. An email that could not be sent is not recorded, so the
  next run tries again. Alerts never fail a run.
- **Content:** French, plain text: what stopped, when (Paris time), the
  commands that fix it. No secret and no offer content.

## Consequences

- `ALERTS_TO` must be set on the server that runs `SCRAPE_CRON`
  (`scraper.env`); a local run with it set would email too.
- Up to one email per problem per day; at most two kinds today.
- The alert address is personal data of the operator: it lives in the
  server's settings only and is never logged.
