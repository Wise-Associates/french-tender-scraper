# ADR 0006 — Show the Partenaire GC session state in MyBestConsultant

- Status: accepted
- Date: 2026-11-19

## Context

When the Partenaire GC session expires, nothing reaches MyBestConsultant
any more, and the only signal was the alert email (ADR 0005), which is easy
to miss. Wise Associates asked for a danger label on MyBestConsultant's AO
page, `/admin/candidats`, where the team works every day.

The scraper runs in a container with no published port and an API without
authentication: MyBestConsultant cannot ask it. The veille already pushes its
run reports to MyBestConsultant (its ADR 0030).

## Decision

- The scraper **pushes** the state after each run of a site whose login is
  done by hand (`manualSession`, Partenaire GC only):
  `POST $MBC_STATUS_URL` with `Authorization: Bearer $MBC_STATUS_TOKEN` and
  `{ schemaVersion: 1, site, state: "ok" | "session_expired", checkedAt }`
  (`src/alerts/mbc-status.ts`; same format as MyBestConsultant's
  `src/lib/veille/scraper-status.ts`, changed together). MyBestConsultant
  accepts only the sites of its own list (`SCRAPER_SITES`) and sets the name
  shown: a new manual-session site must be added there too.
- `session_expired` when the run stops on `SessionMissingError` (listing or
  detail pages); `ok` once the listing and the detail pages were read. Any
  other failure (site down…) sends nothing: the last known state stays.
- A **token of its own**, not the veille's `VEILLE_CONFIG_TOKEN`: it can only
  set this state, nothing else.
- Never fails the run (15 s timeout, errors logged without the token); no
  retry, the next run sends the state of that moment. MyBestConsultant ignores
  a state older than the one it keeps.
- A state refused or not delivered emails the operator (alert `mbc-status`,
  once a day as in ADR 0005, cleared by the next state that gets through):
  otherwise the banner would silently stay red after a new login, or never
  appear, e.g. after the token was changed on one side only.
- `MBC_STATUS_URL` must be https (http only for localhost), without user or
  password (fetch would quote them in its error), and redirects are refused;
  URL and token are checked at startup, both or neither.

## Consequences

- MyBestConsultant shows a red banner on `/admin/candidats` from the first
  run that finds the session expired until the next run that reads the site
  (its ADR 0048). The alert email stays.
- Rollout order: MyBestConsultant first (collection `scraper_status`,
  `APPWRITE_COLLECTION_SCRAPER_STATUS`, `SCRAPER_STATUS_TOKEN`, deployment),
  then `MBC_STATUS_URL` / `MBC_STATUS_TOKEN` here. In the other order the
  scraper only logs refusals.
- A scraper that stops running leaves its last state on screen: a dead
  scraper is not detected by this banner.
- A local run with these settings would overwrite the server's state: set
  them on the server only.
