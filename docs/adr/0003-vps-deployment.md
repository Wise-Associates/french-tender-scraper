# ADR 0003 — Deploy on MyBestConsultant's VPS like the veille

- Status: accepted
- Date: 2026-11-14

## Context

Wise Associates deploys every project the same way (MyBestConsultant, veille-marches-emplois): Docker on
MyBestConsultant's VPS, a manual GitHub Actions workflow, and a server script behind a restricted SSH key.
The scraper needs Chromium, a SQLite file, a Partenaire GC session that only a person can create (anti-bot
login, ADR 0001), and its API has no authentication.

## Decision

- Copy the veille's setup: workflow « Deploy to the VPS » (verify job without secrets, deploy job in the
  `production` environment), `docker save | ssh deploy@VPS deploy <commit>`, server script
  `tender-scraper-deploy` (commit on `main`, single-image archive, compose shape check, rollback, 5 images).
- Image built on Playwright's image at the exact `playwright` version (pinned by digest): Chromium and its
  libraries match the library. Read-only container, unprivileged uid 10001, 1 GB of shared memory for
  Chromium, data in one host folder mounted on `/data`.
- **No published port**: the API stays inside the container; runs are scheduled or started with
  `tender-scraper-deploy run` (`docker exec`).
- The session is created on an operator's machine and installed with `tender-scraper-deploy session`, which
  only accepts partenaire-gc.com cookies. `run` and `session` are refused over the CI key.
- The local `docker-compose.yml` is removed: local work uses `npm run start:dev`.

## Consequences

- About 2 GB per image, 5 kept: ~10 GB of disk on the shared server.
- An operator logs in again about every 3 weeks (session lifetime) and resends the session.
- The CI key can still deploy any image with the scraper's secrets (same accepted risk as the veille):
  protections on `main` and required reviewers on `production` are mandatory.
