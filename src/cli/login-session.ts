/**
 * Manual login for sites whose login form must not be automated (anti-bot
 * check). Opens a visible browser on the site's login page; you log in
 * yourself, then press Enter in the terminal. If the login form is gone, the
 * session (cookies + localStorage) is saved where BrowserService loads it, and
 * the scraper reuses it until it expires.
 *
 * Usage (after `npm run build`, on a machine with a display):
 *   npm run login:session -- <site>
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { stdin, stdout } from 'process';
import { createInterface } from 'readline/promises';
import { BrowserContext, chromium } from 'playwright';
import { sessionFilePath } from '../scrapers/browser.service';
import { PARTENAIRE_GC_LOGIN } from '../scrapers/partenaire-gc.scraper';

const MANUAL_LOGIN_SITES = new Map<string, { url: string; loginFormSelector: string }>([
  ['partenaire-gc', PARTENAIRE_GC_LOGIN],
]);

async function main(): Promise<void> {
  const site = process.argv[2] ?? '';
  const target = MANUAL_LOGIN_SITES.get(site);
  if (!target) {
    throw new Error(
      `Usage: npm run login:session -- <site>   (sites: ${[...MANUAL_LOGIN_SITES.keys()].join(', ')})`,
    );
  }

  // Same SESSIONS_DIR as the API, which reads it from .env.
  if (existsSync('.env')) process.loadEnvFile('.env');
  const sessionsDir = process.env.SESSIONS_DIR || './sessions';
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const sessionPath = sessionFilePath(sessionsDir, site);

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ locale: 'fr-FR' });
    const page = await context.newPage();
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    await waitForEnter(`Log in to ${site} in the browser window, then press Enter here… `);

    // Check on the login page itself, wherever the user navigated to. An error
    // or maintenance page has no login form either, so it must not count as
    // "logged in".
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (response && !response.ok()) {
      throw new Error(`Could not check the login: HTTP ${response.status()} from ${target.url}. Nothing was saved.`);
    }
    if ((await page.locator(target.loginFormSelector).count()) > 0) {
      throw new Error('Still logged out (the login form is shown): nothing was saved. Run the command again.');
    }

    saveSession(sessionPath, await siteOnlyState(context, new URL(target.url).hostname));
    console.log(`Session saved to ${sessionPath}. The scraper reuses it until it expires.`);
  } finally {
    await browser.close();
  }
}

/** Resolves on Enter; rejects on Ctrl+C or Ctrl+D so the browser gets closed. */
async function waitForEnter(question: string): Promise<void> {
  const cancel = new AbortController();
  const prompt = createInterface({ input: stdin, output: stdout });
  // In a terminal, Ctrl+C reaches readline as a keypress, not as a process
  // signal: without these handlers the prompt would hang with the browser open.
  prompt.on('SIGINT', () => cancel.abort());
  prompt.on('close', () => cancel.abort());
  try {
    await prompt.question(question, { signal: cancel.signal });
  } catch (err) {
    if (cancel.signal.aborted) throw new Error('\nCancelled: nothing was saved.');
    throw err;
  } finally {
    prompt.close();
  }
}

/**
 * The browser state limited to the site's own domain: anything else opened in
 * that window (webmail for a password reset, an SSO or payment page…) must not
 * end up in the session file the scraper loads.
 */
async function siteOnlyState(context: BrowserContext, host: string) {
  const isSiteDomain = (domain: string) => {
    const d = domain.replace(/^\./, '');
    return d === host || d.endsWith(`.${host}`) || host.endsWith(`.${d}`);
  };
  const state = await context.storageState();
  return {
    cookies: state.cookies.filter((c) => isSiteDomain(c.domain)),
    origins: state.origins.filter((o) => isSiteDomain(new URL(o.origin).hostname)),
  };
}

/**
 * The file holds session cookies (anyone who has it is logged in as you), so it
 * is owner-only. Written to a fresh temp file then renamed: the mode applies
 * even when replacing an older session, and the API never reads a half-written
 * file.
 */
function saveSession(sessionPath: string, state: object): void {
  const tmpPath = `${sessionPath}.tmp`;
  rmSync(tmpPath, { force: true });
  writeFileSync(tmpPath, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmpPath, sessionPath);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});
