# The tender scraper on the VPS

Same setup as the veille (veille-marches-emplois, `docs/deploiement-vps.md`) on MyBestConsultant's server:
GitHub Actions builds the image and sends it over SSH; a server script checks it and replaces the container.
Decision: [ADR 0003](adr/0003-vps-deployment.md).

## 1. Overview

| What | Where |
|---|---|
| Container `tender-scraper` (image `french-tender-scraper:<commit>`) | started by `tender-scraper-deploy`, from `deploy/compose.yml` |
| Database (`db/tenders.db`), Partenaire GC session (`sessions/`) | `/opt/french-tender-scraper/data` (owned by uid 10001) |
| Secrets and settings | `/etc/french-tender-scraper/scraper.env` |
| Server copy of the repository (deploy files only) | `/opt/french-tender-scraper/repo` |
| Deployment log, online commit | `/opt/french-tender-scraper/deployment` |

- **Runs**: at the fixed Paris times of `SCRAPE_CRON` (NestJS scheduler, inside the container), plus
  `tender-scraper-deploy run`. Each run scrapes, filters and analyses new offers, then emails relevant ones
  to the AO inbox.
- **No published port**: the API has no authentication, so it is only reachable inside the container.
- **Login**: never automated (Partenaire GC's anti-bot check). You log in on your machine and send the
  session to the server, about every 3 weeks (part 6).

## 2. Prepare the server (once)

The server is already prepared by MyBestConsultant's guide (admin account, Docker, `deploy` user in the
`docker` group), as for the veille. Check:

```bash
docker compose version     # v2.24 or newer
id deploy                  # must list the « docker » group
python3 --version          # used by tender-scraper-deploy for its checks
getent passwd 10001        # no line expected: the container user has no account
df -h /                    # the image is about 2 GB, 5 versions are kept: count ~10 GB
```

### 2.1 Folders

```bash
sudo install -d -o deploy -g deploy -m 750 /opt/french-tender-scraper
sudo install -d -o deploy -g deploy -m 750 /opt/french-tender-scraper/deployment
sudo install -d -o 10001 -g 10001 -m 700 /opt/french-tender-scraper/data
sudo install -d -o 10001 -g 10001 -m 700 /opt/french-tender-scraper/data/db /opt/french-tender-scraper/data/sessions
sudo install -d -o root -g deploy -m 750 /etc/french-tender-scraper
```

### 2.1b Bring the existing database (before the first deployment)

An offer must be emailed once only, and « already sent » is recorded in the database
(`tender_ao_emails`). A fresh database on the server would send again every offer already sent from
your machine. So the server starts from your database, and from then on **only the server sends**.

On your machine, stop `npm run start:dev`, then make a consistent copy (SQLite WAL included):

```bash
node -e "new (require('better-sqlite3'))('data/tenders.db').backup('tenders-copy.db').then(() => console.log('ok'))"
scp tenders-copy.db <admin>@<ip>:
```

On the server:

```bash
sudo install -o 10001 -g 10001 -m 600 tenders-copy.db /opt/french-tender-scraper/data/db/tenders.db && rm tenders-copy.db
```

Then, on your machine, empty `OFFERS_TO` in `.env` (and keep `SCRAPE_CRON` empty): a local run
would otherwise send the same new offers as the server.

### 2.2 Copy of the repository

The server reads this repository with **its own read-only key** (GitHub accepts a deploy key on one
repository only).

```bash
sudo -u deploy ssh-keygen -t ed25519 -N "" -C "vps tender-scraper (repo read)" -f /home/deploy/.ssh/github_tender_scraper
sudo -u deploy tee -a /home/deploy/.ssh/config > /dev/null <<'EOF'

# Tender scraper repository: its own deploy key.
Host github-tender-scraper
  HostName github.com
  User git
  IdentityFile ~/.ssh/github_tender_scraper
  IdentitiesOnly yes
EOF
sudo cat /home/deploy/.ssh/github_tender_scraper.pub
```

On GitHub: repository → Settings → Deploy keys → Add deploy key, paste the public key, **without** « Allow
write access ». Then (replace the repository name with yours):

```bash
sudo -u deploy ssh -T github-tender-scraper
sudo -u deploy git clone github-tender-scraper:Wise-Associates/french-tender-scraper.git /opt/french-tender-scraper/repo
```

Never edit files in this copy: each deployment checks out the deployed commit.

### 2.3 Deployment script

```bash
sudo install -m 755 /opt/french-tender-scraper/repo/deploy/tender-scraper-deploy.sh /usr/local/bin/tender-scraper-deploy
sudo -u deploy tender-scraper-deploy status    # expected: « no version deployed »
```

### 2.4 Secrets: `scraper.env`

```bash
sudo install -o root -g deploy -m 640 /dev/null /etc/french-tender-scraper/scraper.env
sudoedit /etc/french-tender-scraper/scraper.env
```

One variable per line, each value in single quotes, no `export` (without quotes Docker silently drops what
follows a `$`). Roles in `.env.example`.

```
SCRAPE_CRON='0 8,12,16,20 * * *'
PARTENAIREGC_ENABLED='true'
MAXIMILIEN_ENABLED='false'
AWSOLUTIONS_ENABLED='false'
ACHATPUBLIC_ENABLED='false'
EMARCHESPUBLICS_ENABLED='false'
BPIFRANCE_ENABLED='false'
ANTHROPIC_API_KEY='<Anthropic key>'
ANALYSIS_MAX_PER_RUN='40'
OPENAI_API_KEY='<OpenAI key, or empty: no fallback>'
OPENAI_MODEL=''
SMTP_HOST='<same as the veille>'
SMTP_PORT='587'
SMTP_USER='<…@wise-associates.fr>'
SMTP_PASSWORD='<password of that mailbox>'
MAIL_FROM='Veille Partenaire GC <…@wise-associates.fr>'
OFFERS_TO='ao@wise-associates.fr'
ALERTS_TO='<your address>'
MBC_STATUS_URL='https://<MyBestConsultant domain>/api/scraper/status'
MBC_STATUS_TOKEN='<same value as SCRAPER_STATUS_TOKEN in /etc/mybestconsultant/app.env>'
```

- `SCRAPE_CRON`: Paris time; `0 8,12,16,20 * * *` = 4 runs a day, `0 8,14 * * *` = 2. A run still going when
  the next is due makes that one skipped. An invalid expression stops the startup (previous version put back).
- `SMTP_PORT='587'`: Hetzner blocks outgoing ports 25 and 465.
- Do not set `DATA_DIR`, `SESSIONS_DIR` or `DEBUG_SCRAPER` (fixed by `deploy/compose.yml`).
- Every other site is disabled: only Partenaire GC is meant to run here.
- `ALERTS_TO`: who is emailed when the Partenaire GC session expires or Claude has a credit problem (README,
  « Operator alerts »). An invalid address stops the startup (previous version put back).
- `OPENAI_API_KEY`: used only while Claude refuses for a credit problem (ADR 0004).
- `MBC_STATUS_URL` / `MBC_STATUS_TOKEN`: the Partenaire GC session state, shown as a red banner on MyBestConsultant's
  `/admin/candidats` (ADR 0006). Set them once MyBestConsultant has the `scraper_status` collection and
  `SCRAPER_STATUS_TOKEN` (its ADR 0048); before that, each run logs a refusal (401 or 503) and nothing else changes.
  Invalid values stop the startup (previous version put back).

### 2.5 SSH key for GitHub Actions

On **your machine**, in a temporary folder:

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions deploy tender-scraper" -f tender-scraper-deploy-key
cat tender-scraper-deploy-key.pub
```

On the server, **append** it to deploy's keys, limited to `tender-scraper-deploy` (one line). `tee -a`: a
`tee` without `-a` would erase MyBestConsultant's and the veille's keys.

```bash
sudo -u deploy tee -a /home/deploy/.ssh/authorized_keys > /dev/null <<'EOF'
restrict,command="/usr/local/bin/tender-scraper-deploy" ssh-ed25519 AAAA...paste-the-key... github-actions deploy tender-scraper
EOF
sudo cat /home/deploy/.ssh/authorized_keys    # mbc-deploy, veille-deploy and tender-scraper-deploy lines
```

From your machine: `ssh -o IdentitiesOnly=yes -i tender-scraper-deploy-key deploy@<ip> status` prints « no
version deployed ». The private key goes to GitHub (part 3); then delete both files from your machine.

This key can send any image, which would start with the secrets of `scraper.env`: it is only given to the
deploy job, from `main`. It cannot run `run` or `session` (refused over SSH).

## 3. Configure GitHub (once)

1. **Repository**: create it in the Wise-Associates organisation, then on your machine:
   `git branch -m master main`, `git remote add origin git@github.com:Wise-Associates/french-tender-scraper.git`,
   `git push -u origin main`.
2. **Protections** (mandatory on this shared server): Rules → Rulesets → branch ruleset on `main`, no bypass:
   Require a pull request (one approval), Block force pushes, Restrict deletions.
3. **Environments → New environment** `production`: deployment branches `main` only, **Required reviewers**
   with Prevent self-review. Secrets:
   - `VPS_SSH_KEY`: the content of `tender-scraper-deploy-key` (private key, BEGIN/END lines included);
   - `VPS_SSH_KNOWN_HOSTS`: the server fingerprint, the same as for MyBestConsultant
     (`ssh-keyscan -t ed25519 <ip> 2>/dev/null`).
4. **Secrets and variables → Actions → Variables**: `VPS_HOST` = the server IP.
5. **Actions → General**: keep the default workflow permissions read-only.

## 4. Deploy

Actions → « Deploy to the VPS » → Run workflow, branch `main`; approve in the `production` environment.
The server checks the commit is on `main`, the archive holds this image only, and the container shape;
it starts the new version and puts back the previous one if it does not become healthy.

## 5. Day to day

```bash
sudo -u deploy tender-scraper-deploy status             # online version, container, images kept
sudo -u deploy tender-scraper-deploy run                # a scrape now (prints the result, a few minutes)
sudo -u deploy tender-scraper-deploy restart            # after editing scraper.env
sudo -u deploy tender-scraper-deploy rollback <commit>  # one of the 5 kept images
sudo docker logs --tail 100 tender-scraper                   # runs, analysis, emails
```

After a change to `deploy/tender-scraper-deploy.sh` on `main`, reinstall it (the deployment warns you):
`sudo install -m 755 /opt/french-tender-scraper/repo/deploy/tender-scraper-deploy.sh /usr/local/bin/tender-scraper-deploy`.

Backups: `/opt/french-tender-scraper/data/db/tenders.db` (SQLite; copy it with the container stopped, or with
`sqlite3 … ".backup"`).

## 6. Partenaire GC session (first deploy, then about every 3 weeks)

When runs report « Partenaire GC session missing or expired » — with `ALERTS_TO` set you get an email
« Session Partenaire GC expirée », then a reminder each day, and MyBestConsultant's `/admin/candidats` shows a red
banner until the next run that reads the site — on **your machine**:

```bash
npm run build && npm run login:session -- partenaire-gc     # log in in the window, press Enter
scp sessions/partenaire-gc.json <admin>@<ip>:
ssh -t <admin>@<ip> 'sudo -u deploy tender-scraper-deploy session < partenaire-gc.json; rm -f partenaire-gc.json'
```

Two steps because sudo asks for your password: `-t` gives it a terminal, which a single
`ssh … < file` cannot (its input is the file). The copy is deleted even if the command fails.
Before the first deployment, `session` stops with « no version deployed » (it needs the app's image).

The server only accepts a file holding partenaire-gc.com cookies, writes it readable by the container only,
and the next run uses it (no restart needed). The file is a login: never leave a copy elsewhere.
