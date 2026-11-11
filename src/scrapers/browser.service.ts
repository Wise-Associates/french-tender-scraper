import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chromium, Browser, BrowserContext } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Owns the headless browser and one persistent BrowserContext per site.
 * Session cookies/localStorage are saved to disk (Playwright storageState)
 * after a successful login so you only authenticate once per site.
 */
@Injectable()
export class BrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserService.name);
  private browser?: Browser;
  private readonly contexts = new Map<string, BrowserContext>();

  constructor(private readonly config: ConfigService) {
    mkdirSync(this.config.get<string>('SESSIONS_DIR') ?? './sessions', { recursive: true });
  }

  async context(site: string): Promise<BrowserContext> {
    const cached = this.contexts.get(site);
    if (cached) return cached;

    const browser = await this.ensureBrowser();
    const sessionPath = join(
      this.config.get<string>('SESSIONS_DIR') ?? './sessions',
      `${site}.json`,
    );

    const context = await browser.newContext({
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
      viewport: { width: 1440, height: 900 },
      userAgent:
        this.config.get<string>('SCRAPER_USER_AGENT') ??
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
      ...(existsSync(sessionPath) ? { storageState: sessionPath } : {}),
    });

    // Block heavy resources we never need — faster and gentler on the servers.
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      return ['image', 'media', 'font', 'stylesheet'].includes(type)
        ? route.abort()
        : route.continue();
    });

    this.contexts.set(site, context);
    return context;
  }

  /** Persist cookies/localStorage so the next run skips the login flow. */
  async persistSession(site: string, context: BrowserContext): Promise<void> {
    const sessionPath = join(
      this.config.get<string>('SESSIONS_DIR') ?? './sessions',
      `${site}.json`,
    );
    await context.storageState({ path: sessionPath });
    this.logger.log(`Session saved for "${site}" -> ${sessionPath}`);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    const headless = this.config.get<string>('HEADLESS') !== 'false';
    this.browser = await chromium.launch({
      headless,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
    return this.browser;
  }

  async onModuleDestroy(): Promise<void> {
    for (const context of this.contexts.values()) await context.close().catch(() => undefined);
    this.contexts.clear();
    await this.browser?.close().catch(() => undefined);
  }
}
