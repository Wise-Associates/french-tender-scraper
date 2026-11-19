import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MbcStatusReporter, parseMbcStatusConfig } from './mbc-status';

// Fictitious URL and token; fetch is replaced, nothing leaves the machine.
const URL_OK = 'https://mbc.example.test/api/scraper/status';
const TOKEN = 'test-token-not-real-0123456789abcdef';
const checkedAt = new Date('2026-11-19T07:00:00.000Z');

function reporter(env: Record<string, string | undefined> = { MBC_STATUS_URL: URL_OK, MBC_STATUS_TOKEN: TOKEN }) {
  return new MbcStatusReporter({ get: (key: string) => env[key] } as ConfigService);
}

describe('parseMbcStatusConfig', () => {
  it('is off when both are empty', () => {
    assert.equal(parseMbcStatusConfig(undefined, undefined), undefined);
    assert.equal(parseMbcStatusConfig(' ', ''), undefined);
  });

  it('accepts an https URL, or http on this machine, with a long enough token', () => {
    assert.deepEqual(parseMbcStatusConfig(URL_OK, TOKEN), { url: URL_OK, token: TOKEN });
    assert.ok(parseMbcStatusConfig('http://localhost:3000/api/scraper/status', TOKEN));
  });

  it('refuses half a setting, plain http to another host or a weak token, without printing the token', () => {
    assert.throws(() => parseMbcStatusConfig(URL_OK, ''), /go together/);
    assert.throws(() => parseMbcStatusConfig('', TOKEN), /go together/);
    assert.throws(() => parseMbcStatusConfig('http://mbc.example.test/api/scraper/status', TOKEN), /https/);
    assert.throws(() => parseMbcStatusConfig('mbc.example.test', TOKEN), /not a URL/);
    // Built here rather than written out, so no credential-shaped string sits in the repository.
    const withCredentials = new URL(URL_OK);
    withCredentials.username = 'user';
    withCredentials.password = 'fake-password';
    assert.throws(
      () => parseMbcStatusConfig(withCredentials.toString(), TOKEN),
      (err: Error) => /user or password/.test(err.message) && !err.message.includes('fake-password'),
    );
    for (const bad of ['too-short', `${TOKEN}\nsecond-line`, `${TOKEN} space`]) {
      assert.throws(() => parseMbcStatusConfig(URL_OK, bad), (err: Error) => /MBC_STATUS_TOKEN/.test(err.message) && !err.message.includes('test-token'));
    }
  });
});

describe('MbcStatusReporter', () => {
  afterEach(() => mock.restoreAll());

  it('sends the state in MyBestConsultant’s format, with the token', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('{"ok":true,"saved":true}', { status: 200 }));
    assert.equal(await reporter().report('partenaire-gc', 'session_expired', checkedAt), undefined);
    const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(url, URL_OK);
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init.body)), {
      schemaVersion: 1,
      site: 'partenaire-gc',
      state: 'session_expired',
      checkedAt: '2026-11-19T07:00:00.000Z',
    });
  });

  it('sends nothing when not configured', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('', { status: 200 }));
    mock.method(Logger.prototype, 'warn', () => undefined);
    await reporter({}).report('partenaire-gc', 'ok', checkedAt);
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it('never fails the run: a refusal or an unreachable MyBestConsultant is logged without the token', async () => {
    const logged = mock.method(Logger.prototype, 'error', () => undefined);
    mock.method(globalThis, 'fetch', async () => new Response('{"error":"Suivi du scraper non configuré."}', { status: 503 }));
    assert.match((await reporter().report('partenaire-gc', 'ok', checkedAt)) ?? '', /^HTTP 503 .*non configuré/);

    mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed');
    });
    assert.equal(await reporter().report('partenaire-gc', 'ok', checkedAt), 'fetch failed');

    const lines = logged.mock.calls.map((call) => String(call.arguments[0]));
    assert.match(lines[0], /HTTP 503 .*non configuré/);
    assert.match(lines[1], /fetch failed/);
    assert.ok(lines.every((line) => !line.includes(TOKEN)));
  });
});
