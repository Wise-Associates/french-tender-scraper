# Scraper image (ADR 0003): the NestJS API with its scheduler and Playwright's Chromium.
# Built by .github/workflows/deploy-vps.yml, run on the VPS by deploy/tender-scraper-deploy.sh with
# deploy/compose.yml. Guide: docs/deployment-vps.md.
#
# Playwright's image: Chromium and its system libraries, at the exact version of the `playwright` package
# (pnpm-lock.yaml). Upgrading playwright means upgrading this tag and digest together
# (docker buildx imagetools inspect mcr.microsoft.com/playwright:v<version>-noble).
ARG BASE_IMAGE=mcr.microsoft.com/playwright:v1.65.0-noble@sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe

FROM ${BASE_IMAGE} AS build
WORKDIR /app
RUN npm install --global pnpm@10.17.1
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: no browser download (the base image has Chromium); the only native addon is built explicitly.
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild better-sqlite3
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod --ignore-scripts

FROM ${BASE_IMAGE}
WORKDIR /app
# HOME: Chromium writes its profile there; /tmp is the only writable place besides /data (read-only container).
ENV NODE_ENV=production \
    NO_COLOR=1 \
    HOME=/tmp \
    DATA_DIR=/data/db \
    SESSIONS_DIR=/data/sessions
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Unprivileged user with no account on the server (like the veille); owns /data on the server.
USER 10001:10001
CMD ["node", "--enable-source-maps", "dist/main.js"]
