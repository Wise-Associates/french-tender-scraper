import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SiteKey } from '../scrapers/tender.types';

/**
 * Session state of a site whose login is done by hand (Partenaire GC), sent to
 * MyBestConsultant after each run (ADR 0006): its /admin/candidats page shows
 * a red banner while the session is expired. Same format as MyBestConsultant's
 * src/lib/veille/scraper-status.ts (`schemaVersion`): change both projects together.
 */
export const MBC_STATUS_VERSION = 1;
export type SessionState = 'ok' | 'session_expired';

export interface MbcStatusConfig {
  url: string;
  token: string;
}

const TIMEOUT_MS = 15_000;

/**
 * MBC_STATUS_URL and MBC_STATUS_TOKEN: both or neither (neither: nothing is
 * sent). The URL must be https (http only for a MyBestConsultant running on
 * this machine); the token is what MyBestConsultant requires (32 characters or
 * more) and printable ASCII, since fetch() quotes an invalid header value in
 * its error. Checked at startup; the messages never contain the values.
 */
export function parseMbcStatusConfig(rawUrl: string | undefined, rawToken: string | undefined): MbcStatusConfig | undefined {
  const url = rawUrl?.trim() ?? '';
  const token = rawToken?.trim() ?? '';
  if (!url && !token) return undefined;
  if (!url || !token) throw new Error('MBC_STATUS_URL and MBC_STATUS_TOKEN go together: set both, or neither');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('MBC_STATUS_URL is not a URL (expected https://<MyBestConsultant>/api/scraper/status)');
  }
  // fetch() refuses such a URL and quotes it whole in its error, which would put the password in the logs and emails.
  if (parsed.username || parsed.password) {
    throw new Error('MBC_STATUS_URL must not contain a user or password (the token is the only credential)');
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new Error('MBC_STATUS_URL must use https (the token travels with each request)');
  }
  if (!/^[\x21-\x7E]{32,}$/.test(token)) {
    throw new Error('MBC_STATUS_TOKEN must be 32 printable characters or more, without spaces (same value as SCRAPER_STATUS_TOKEN in MyBestConsultant)');
  }
  return { url: parsed.toString(), token };
}

@Injectable()
export class MbcStatusReporter {
  private readonly logger = new Logger(MbcStatusReporter.name);
  private readonly config?: MbcStatusConfig;

  constructor(config: ConfigService) {
    this.config = parseMbcStatusConfig(config.get<string>('MBC_STATUS_URL'), config.get<string>('MBC_STATUS_TOKEN'));
    if (!this.config) this.logger.warn('MBC_STATUS_URL is empty: session states are not shown in MyBestConsultant');
  }

  /**
   * Never throws: MyBestConsultant being unreachable must not fail the run.
   * Nothing to retry either: the next run sends the state of that moment.
   * Returns why the state did not get through (the caller alerts the
   * operator: the banner would stay as it was), undefined when it did or when
   * the feature is off.
   */
  async report(site: SiteKey, state: SessionState, checkedAt: Date): Promise<string | undefined> {
    if (!this.config) return undefined;
    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' },
        // The site name shown in the banner is set by MyBestConsultant (its SCRAPER_SITES), not sent from here.
        body: JSON.stringify({ schemaVersion: MBC_STATUS_VERSION, site, state, checkedAt: checkedAt.toISOString() }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // This endpoint never redirects: a redirect would mean a wrong MBC_STATUS_URL.
        redirect: 'error',
      });
      if (!response.ok) {
        // MyBestConsultant's error messages name the problem, never a secret.
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        return this.failed(site, `HTTP ${response.status} ${detail}`.trim());
      }
      this.logger.log(`Session state of ${site} sent to MyBestConsultant: ${state}`);
      return undefined;
    } catch (err) {
      return this.failed(site, err instanceof Error ? err.message : String(err));
    }
  }

  private failed(site: SiteKey, problem: string): string {
    this.logger.error(`Session state of ${site} not accepted by MyBestConsultant: ${problem}`);
    return problem;
  }
}
