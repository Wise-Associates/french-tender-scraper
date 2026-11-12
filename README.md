# French Tender Scraper (NestJS)

Scrapes appels d'offres from five French public-procurement platforms and the
Partenaire GC subscriber area:

| Site key        | Platform                                                        | Login needed |
|-----------------|-----------------------------------------------------------------|--------------|
| `maximilien`    | Maximilien — Île-de-France (marches.maximilien.fr)              | Yes (free, SIRET-based account) |
| `aw-solutions`  | AW Solutions (marches-publics.info)                             | Yes (enterprise account) |
| `achatpublic`   | achatpublic.com — salle des marchés                             | Yes (Identifiant + password) |
| `emarchespublics` | e-marchespublics.com                                            | No for the public "derniers AO" list |
| `bpifrance`     | Bpifrance appels d'offres (bpifrance.fr/appels-offres)          | No |
| `partenaire-gc` | Partenaire GC — espace abonné (partenaire-gc.com/espace-abonne) | Yes (paid subscription, [manual login](#partenaire-gc-manual-login)) |

> ⚠️ **Legal note** — These are private platforms whose Terms of Service
> generally restrict automated access, including with your own account
> (achatpublic.com additionally ties access to client certificates).
> Run this only after reviewing each platform's CGU, keep the built-in rate
> limits, and prefer official open data when it covers your need: BOAMP
> (boamp.fr / API), the DECP dataset on data.gouv.fr, or PLACE
> (marches-publics.gouv.fr) for State tenders — most tenders on the
> platforms above are republications of those public sources.
> Partenaire GC's *mentions légales* forbid reproducing or copying any part of
> the site without its prior authorisation, except for private personal use:
> storing its offers for business use needs their agreement — and the Claude
> analysis below sends each new offer's description to Anthropic's API.

## Architecture

```
src/
├── main.ts / app.module.ts
├── cli/login-session.ts  # manual login for sites whose login form is not automated
├── tenders/            # SQLite storage (better-sqlite3), REST search API
├── analysis/           # Claude analysis of offer details (classification + extraction)
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
npm test                      # builds, then runs the unit tests (node:test, no extra dependency)
```

With pnpm (≥ 10), dependency build scripts only run for packages listed in
`pnpm.onlyBuiltDependencies` in `package.json`. `better-sqlite3` is listed there
because it needs its native addon; without it the app crashes at startup with
"Could not locate the bindings file". If you installed before that entry existed,
run `pnpm rebuild better-sqlite3`.

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

Only one run happens at a time: a run requested (API or schedule) while another
is in progress is refused — the API answers `409 Conflict`.

## Partenaire GC: manual login

The Partenaire GC login form is protected by an anti-bot check (Drupal Antibot
module) that only accepts a submission after real human interaction. The
scraper therefore never submits it: you log in yourself once, the session is
saved, and the scraper reuses it. There are no Partenaire GC credentials in
`.env`.

```bash
npm run build                               # the command runs from dist/
npm run login:session -- partenaire-gc
```

A browser window opens on the subscriber area: log in, then press Enter in the
terminal (Ctrl+C cancels). The command checks that the login form is gone and
saves the partenaire-gc.com session to `sessions/partenaire-gc.json` (readable
by its owner only — anyone holding this file is logged in as you; cookies of
other sites opened in that window are not saved). It needs a display, so run it on your machine,
not inside the Docker container; the container reads `./sessions` through its
volume.

When the session expires, runs fail with *"Partenaire GC session missing or
expired"*: run the command again — no API restart needed.

What is scraped: the **"Consultations en cours"** listing of the subscriber area,
every page of it. Per offer: title (profile sought), client (*enseigne —
filiale*), publication date, end of consultation, location (`region`), and in
`description` the code affaire, daily rate, PGC/RFA commission and payment
terms. The offer's URL slug is its `external_id` (some *codes affaire* are
date-like and could repeat). Parsing lives in
`src/scrapers/partenaire-gc.listing.ts`, tested by `npm test`.

`keywords` are matched on our side: an offer is kept when **any** keyword
appears in its title, client or description, ignoring case and accents. To
use the site's own filters instead, set `PARTENAIREGC_SEARCH_URL` to a
`https://partenaire-gc.com/consultations?...` search URL.

## Claude analysis of offers (Partenaire GC)

After each Partenaire GC scrape, every offer **not analysed yet** is opened
(its detail page) and sent once to Claude (`claude-sonnet-5-5`), which says
whether it belongs to one of these categories and extracts its key details:

| Category key | Covers |
|---|---|
| `developpement_logiciel_saas` | software development, tech lead, software architecture, SaaS, integration/API, QA |
| `pilotage_it_agile` | IT project management, PMO, MOA/AMOA, product owner, business analyst, Scrum Master, agile coach |
| `data_ia` | data engineering/analysis/science, BI, data governance, machine learning, generative AI |

Infrastructure, network, cloud, cybersecurity, support and non-IT missions are
deliberately **not** matched. The list and its wording live in
`src/analysis/offer-analysis.ts` (`OFFER_CATEGORIES`).

- **Relevant** offers get summary, skills, seniority, duration, start date,
  remote work and the mission text stored in `tender_analyses`.
- **Not relevant** offers keep only the outcome (no details) — this prevents
  sending them to Claude again.
- **Declined** by Claude (`refused`): recorded once, not retried.
- **Failures tied to the offer** (no mission description, unusable answer):
  counted in `tender_analysis_failures`; after 3 attempts the offer is set
  aside (logged) — delete its row there to try again.
- **Outages** (site or API down, timeouts): nothing counted, retried on the
  next run. A rejected request (invalid key, bad parameter, rate limit) stops
  the batch at once; 3 API errors in a row stop it too.

Setup: set `ANTHROPIC_API_KEY` in `.env` (and optionally `ANALYSIS_MAX_PER_RUN`,
default 40 offers per run). Without a key, offers are still scraped and the run
reports `"analysis": {"error": "ANTHROPIC_API_KEY is not set…"}`.

```bash
curl 'localhost:3000/api/tenders?relevant=true'        # matched offers, with an "analysis" object
curl 'localhost:3000/api/tenders?relevant=false'       # everything else
```

`limit` must be between 1 and 200 (default 50); page with `offset`.

> ⚠️ The API has **no authentication** and now returns the mission texts of
> the paid subscriber area: keep port 3000 reachable from your machine only
> (in Docker, publish it as `127.0.0.1:3000:3000`).

Each run's result includes an `analysis` block (counts and tokens used; at
$2 / $10 per million input / output tokens, an offer costs about a cent).
Emails and phone numbers (including obfuscated and foreign formats) are masked
before an offer is sent, in the stored text and in Claude's answers; person
names are not detected. To re-analyse offers (e.g. after changing the categories), delete their
rows from `tender_analyses`; the next run picks them up. Design rationale:
[docs/adr/0001-claude-analysis-of-offers.md](docs/adr/0001-claude-analysis-of-offers.md).

## Sending relevant offers to MyBestConsultant's AO inbox

Relevant offers (Claude analysis above) are emailed to MyBestConsultant's AO
inbox (`OFFERS_TO`), one offer per email, in the veille's format (labels
« Intitulé », « Client », « Lieu », « Date limite de réponse », headers
`X-Wise-Veille: scraping` and `X-Wise-Veille-Source: partenaire-gc`), so they
follow MyBestConsultant's extraction and appear on its AO page under the
« Scraping » source. Settings: the `SMTP_*`, `MAIL_FROM` and `OFFERS_TO`
variables of `.env.example` (same values as the veille).

```bash
npm run build
npm run ao:send -- --limit 1 --dry-run   # prints the email that would be sent
npm run ao:send -- --limit 1             # sends it
```

Most urgent deadline first; offers whose deadline has passed are skipped, and
only partenaire-gc.com links are put in the email. An offer is recorded in
`tender_ao_emails` once the SMTP server accepted it and is not sent again (a
crash right after acceptance can re-send it; MyBestConsultant merges the
duplicate). A message the server refuses for its content is skipped and
retried next time; any other SMTP error stops the run. One run at a time
(`data/ao-send.lock`; delete it only if no run is going on). It is a command,
not an API route: the API has no authentication. Rationale: [docs/adr/0002-offers-to-ao-inbox.md](docs/adr/0002-offers-to-ao-inbox.md).

## Calibrating selectors

The CSS selectors are best-effort based on each platform's known structure.
If a scraper reports *"No listings matched any known selector"*:

1. Set `DEBUG_SCRAPER=1` in `.env` and rerun.
2. Open the dumped HTML in `./debug/<site>-listing-*.html` in your browser.
3. Point the relevant `*_SEARCH_URL` / `*_ROW_SELECTOR` env var at the correct
   URL/selectors (or edit the scraper module directly).
4. Set `DEBUG_SCRAPER=0` again and delete the dumps: every run adds new ones,
   and dumps of logged-in areas (Partenaire GC…) contain paid content and your
   account details. They are written readable by their owner only.

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
