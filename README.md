# French Tender Scraper (NestJS)

Scrapes appels d'offres from five French public-procurement platforms:

| Site key        | Platform                                                        | Login needed |
|-----------------|-----------------------------------------------------------------|--------------|
| `maximilien`    | Maximilien — Île-de-France (marches.maximilien.fr)              | Yes (free, SIRET-based account) |
| `aw-solutions`  | AW Solutions (marches-publics.info)                             | Yes (enterprise account) |
| `achatpublic`   | achatpublic.com — salle des marchés                             | Yes (Identifiant + password) |
| `emarchespublics` | e-marchespublics.com                                            | No for the public "derniers AO" list |
| `bpifrance`     | Bpifrance appels d'offres (bpifrance.fr/appels-offres)          | No |

> ⚠️ **Legal note** — These are private platforms whose Terms of Service
> generally restrict automated access, including with your own account
> (achatpublic.com additionally ties access to client certificates).
> Run this only after reviewing each platform's CGU, keep the built-in rate
> limits, and prefer official open data when it covers your need: BOAMP
> (boamp.fr / API), the DECP dataset on data.gouv.fr, or PLACE
> (marches-publics.gouv.fr) for State tenders — most tenders on the
> platforms above are republications of those public sources.

## Architecture

```
src/
├── main.ts / app.module.ts
├── tenders/            # SQLite storage (better-sqlite3), REST search API
└── scrapers/
    ├── browser.service.ts     # Playwright browser + per-site persistent sessions
    ├── base.scraper.ts        # login-once, delays/retries, debug dumps, extraction
    ├── <site>.scraper.ts      # one module per platform
    ├── scraping.service.ts    # orchestration + results
    ├── scraper.scheduler.ts   # periodic runs
    └── scrape.controller.ts   # on-demand runs
```

Each site scraper extends `BaseScraper` and implements two things:
1. `login(page)` — the site's login flow (runs once, session is then saved to disk).
2. `scrape(filters)` — navigate to the listing, apply keywords, extract.

Extraction is selector-driven and configurable via env vars, because these
platforms revamp their HTML regularly.

## Setup

```bash
cp .env.example .env          # fill in your credentials
npm install                   # installs deps + Playwright Chromium
npm run start:dev
```

Or with Docker (recommended — all Playwright system deps included):

```bash
docker compose up --build
```

## Usage

First run a single scraper (Bpifrance needs no login — good smoke test):

```bash
curl -X POST localhost:3000/api/scrape/run \
  -H 'Content-Type: application/json' \
  -d '{"sites": ["bpifrance"]}'
```

Then the ones needing credentials (the first run performs the login and saves
the session to `./sessions/`, so you authenticate only once per site):

```bash
curl -X POST localhost:3000/api/scrape/run \
  -H 'Content-Type: application/json' \
  -d '{"sites": ["maximilien", "aw-solutions", "achatpublic"], "keywords": ["informatique"]}'
```

Query results:

```bash
curl 'localhost:3000/api/tenders?site=maximilien&q=informatique&since=2026-11-01'
curl  localhost:3000/api/tenders/stats
curl  localhost:3000/api/scrape/last-runs
```

Swagger UI: http://localhost:3000/api/docs

Scheduling: set `SCRAPE_INTERVAL_MINUTES` in `.env` (default: every 6 h,
`0` disables). Between platforms the orchestrator waits 5 s, and each
interaction has a randomized delay (`SCRAPE_MIN_DELAY_MS`).

## Calibrating selectors

The CSS selectors are best-effort based on each platform's known structure.
If a scraper reports *"No listings matched any known selector"*:

1. Set `DEBUG_SCRAPER=1` in `.env` and rerun.
2. Open the dumped HTML in `./debug/<site>-listing-*.html` in your browser.
3. Point the relevant `*_SEARCH_URL` / `*_ROW_SELECTOR` env var at the correct
   URL/selectors (or edit the scraper module directly).

For Maximilien and achatpublic, the most reliable approach is: log in manually
with your browser, navigate to the advanced-search results page, copy that URL
into `MAXIMILIEN_SEARCH_URL` / `ACHATPUBLIC_SEARCH_URL`.

## What I still need from you

To finish wiring the logins, for each site that requires one:

- **Maximilien** — your enterprise account login (email/identifiant + password)
- **AW Solutions** — your "Identifiant" + password from marches-publics.info
- **achatpublic.com** — your Identifiant + password

Put them in `.env` (never commit that file). If any site uses 2FA/CAPTCHA,
tell me which — the login flow will need a manual first pass (headed mode:
`HEADLESS=false`, or paste a saved session into `./sessions/`).

## Notes & limits

- Only **reading/listing** tenders is automated — no bid submission, no DCE
  mass-download (those steps typically require qualified eIDAS certificates).
- Data is deduplicated on `(site, external_id)`; `first_seen_at` lets you
  query only-new tenders via `?since=`.
- e-marchespublics: the public homepage list is scraped; the account-based
  filtered search can be added the same way as the other logins.
