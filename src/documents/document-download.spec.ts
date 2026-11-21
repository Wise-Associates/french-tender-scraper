import assert from 'node:assert/strict';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { DocumentProblem, DocumentSession, downloadDocument } from './document-download';

// A local server stands in for the site; every path answers in its own way.
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const routes: Record<string, Handler> = {
  '/ok.pdf': (req, res) => {
    seen.push({ cookie: req.headers.cookie, agent: req.headers['user-agent'] });
    res.end('%PDF-1.4 fictif');
  },
  '/redirect.pdf': (_req, res) => res.writeHead(302, { location: '/ok.pdf' }).end(),
  '/forbidden.pdf': (_req, res) => res.writeHead(403).end('Accès refusé'),
  '/missing.pdf': (_req, res) => res.writeHead(404).end(),
  '/busy.pdf': (_req, res) => res.writeHead(503).end(),
  '/announced-big.pdf': (_req, res) => res.writeHead(200, { 'content-length': String(2048) }).end(Buffer.alloc(2048)),
  '/streamed-big.pdf': (_req, res) => {
    res.writeHead(200);
    const timer = setInterval(() => res.write(Buffer.alloc(512)), 5);
    res.on('close', () => clearInterval(timer));
  },
  '/slow.pdf': () => undefined,
};
const seen: { cookie?: string; agent?: string }[] = [];
let server: Server;
let base: string;
const session: DocumentSession = { cookie: async () => 'SESS=fictif', userAgent: 'TestAgent/1.0' };
const link = (path: string) => ({ name: path.slice(1), url: `${base}${path}` });

async function problemOf(promise: Promise<unknown>): Promise<DocumentProblem> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof DocumentProblem, `unexpected error: ${String(err)}`);
    return err;
  }
  assert.fail('expected a DocumentProblem');
}

describe('downloadDocument', () => {
  before(async () => {
    server = createServer((req, res) => (routes[req.url ?? ''] ?? ((_q, r) => r.writeHead(500).end()))(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('downloads with the session cookie and the browser user agent', async () => {
    const content = await downloadDocument(link('/ok.pdf'), session);
    assert.equal(content.toString(), '%PDF-1.4 fictif');
    assert.deepEqual(seen.at(-1), { cookie: 'SESS=fictif', agent: 'TestAgent/1.0' });
  });

  it('does not follow a redirect and reports a lost session', async () => {
    const requests = seen.length;
    const problem = await problemOf(downloadDocument(link('/redirect.pdf'), session));
    assert.equal(problem.failure, 'session');
    assert.equal(seen.length, requests, 'the redirect target was requested');
  });

  it('tells a lost session, a passing failure and a final one apart', async () => {
    assert.equal((await problemOf(downloadDocument(link('/forbidden.pdf'), session))).failure, 'session');
    const busy = await problemOf(downloadDocument(link('/busy.pdf'), session));
    assert.deepEqual([busy.failure, busy.message], ['temporary', 'HTTP 503']);
    const missing = await problemOf(downloadDocument(link('/missing.pdf'), session));
    assert.deepEqual([missing.failure, missing.message], ['final', 'HTTP 404']);
  });

  it('refuses a file over the limit for good, announced or not', async () => {
    const announced = await problemOf(downloadDocument(link('/announced-big.pdf'), session, { maxBytes: 1024 }));
    const streamed = await problemOf(downloadDocument(link('/streamed-big.pdf'), session, { maxBytes: 4096 }));
    for (const problem of [announced, streamed]) {
      assert.match(problem.message, /plus de/);
      assert.equal(problem.failure, 'final');
    }
  });

  it('gives up after the timeout, worth another try', async () => {
    const problem = await problemOf(downloadDocument(link('/slow.pdf'), session, { timeoutMs: 100 }));
    assert.deepEqual([problem.failure, problem.message], ['temporary', 'délai de téléchargement dépassé']);
  });

  it('reports an unreachable site', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const problem = await problemOf(downloadDocument({ name: 'x.pdf', url: `http://127.0.0.1:${port}/x.pdf` }, session));
    assert.match(problem.message, /téléchargement impossible \(.*ECONNREFUSED/);
    assert.equal(problem.failure, 'temporary');
  });
});
