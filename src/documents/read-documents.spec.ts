import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { CV_TEMPLATE_REASON, DocumentLink, MAX_EMAIL_DOCUMENTS_BYTES } from './offer-documents';
import { readDocumentsForAnalysis, readDocumentsForEmail } from './read-documents';
import { minimalDocx, minimalPdf } from './test-documents';

// Fictitious documents served by a local server standing in for the site.
const files: Record<string, Buffer | number> = {
  '/cdc.pdf': minimalPdf(['Cahier des charges fictif', 'Développeur Java, contact rh@acme.test']),
  '/annexe.docx': minimalDocx(['Annexe fictive', 'Kafka et Angular']),
  '/ancien.doc': Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]),
  '/login.pdf': Buffer.from('<!DOCTYPE html><form class="user-login-form"></form>'),
  '/casse.pdf': Buffer.from('%PDF-1.4\nrien de lisible'),
  '/refuse.pdf': 403,
  '/gros-1.pdf': Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_EMAIL_DOCUMENTS_BYTES / 2 + 10)]),
  '/gros-2.pdf': Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_EMAIL_DOCUMENTS_BYTES / 2 + 10)]),
};
const requested: string[] = [];
let server: Server;
let base: string;
const session = { cookie: async () => 'SESS=fictif', userAgent: 'TestAgent/1.0' };
const links = (...paths: string[]): DocumentLink[] => paths.map((path) => ({ name: path.slice(1), url: `${base}${path}` }));

function counter() {
  const pause = async () => {
    pause.calls += 1;
  };
  pause.calls = 0;
  return pause;
}

describe('reading an offer\'s documents', () => {
  before(async () => {
    server = createServer((req, res) => {
      requested.push(req.url ?? '');
      const file = files[req.url ?? ''];
      if (typeof file === 'number') res.writeHead(file).end();
      else if (file) res.end(file);
      else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('gives the analysis the text of PDF and Word documents, and why the others were not read', async () => {
    requested.length = 0;
    const pause = counter();
    const documents = await readDocumentsForAnalysis(links('/cdc.pdf', '/annexe.docx', '/matrice.xlsx', '/ancien.doc', '/login.pdf', '/casse.pdf'), session, pause);
    const read = documents.map((d) => ('text' in d ? d.text : `! ${d.problem}`));
    assert.deepEqual(read.slice(0, 5), [
      'Cahier des charges fictif\nDéveloppeur Java, contact rh@acme.test',
      'Annexe fictive\nKafka et Angular',
      '! tableur, à télécharger sur l’offre en ligne',
      '! format doc non lu par l’analyse',
      '! le fichier reçu n’est pas un document pdf (session expirée ?)',
    ]);
    assert.match(read[5], /^! illisible \(/);
    assert.ok(!requested.includes('/matrice.xlsx'), 'a spreadsheet was downloaded');
    assert.equal(pause.calls, requested.length, 'one pause before each request, none for documents left out');
  });

  it('attaches the text formats to the email and lists the others', async () => {
    const email = await readDocumentsForEmail(links('/cdc.pdf', '/annexe.docx', '/matrice.xlsx'), session, counter());
    assert.deepEqual(email.attachments.map((a) => [a.filename, a.contentType]), [
      ['cdc.pdf', 'application/pdf'],
      ['annexe.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ]);
    assert.ok(email.attachments[0].content.equals(files['/cdc.pdf'] as Buffer));
    assert.deepEqual(email.notAttached, [{ name: 'matrice.xlsx', reason: 'tableur, à télécharger sur l’offre en ligne' }]);
  });

  it('neither downloads nor analyses nor attaches a CV template to fill', async () => {
    requested.length = 0;
    const template = links('/matrice_cv_fictive.docx');
    const analysed = await readDocumentsForAnalysis(template, session, counter());
    const email = await readDocumentsForEmail(template, session, counter());
    assert.deepEqual(requested, []);
    assert.deepEqual(analysed, [{ ...template[0], problem: CV_TEMPLATE_REASON, failure: 'final' }]);
    assert.deepEqual(email, { attachments: [], notAttached: [{ name: 'matrice_cv_fictive.docx', reason: CV_TEMPLATE_REASON }] });
  });

  it('keeps the email under the size limit', async () => {
    const email = await readDocumentsForEmail(links('/gros-1.pdf', '/gros-2.pdf'), session, counter());
    assert.deepEqual(email.attachments.map((a) => a.filename), ['gros-1.pdf']);
    assert.match(email.notAttached[0].reason, /trop lourd/);
  });

  it('marks the documents of an expired session as such for the analysis', async () => {
    const analysed = await readDocumentsForAnalysis(links('/refuse.pdf', '/cdc.pdf'), session, counter());
    assert.deepEqual(analysed.map((d) => ('failure' in d ? d.failure : 'read')), ['session', 'session']);
  });

  it('stops requesting documents once the site refuses (expired session)', async () => {
    requested.length = 0;
    const email = await readDocumentsForEmail(links('/refuse.pdf', '/cdc.pdf', '/annexe.docx'), session, counter());
    assert.deepEqual(requested, ['/refuse.pdf']);
    assert.equal(email.attachments.length, 0);
    assert.deepEqual(new Set(email.notAttached.map((d) => d.reason)).size, 1);
    assert.match(email.notAttached[2].reason, /session expirée/);
  });
});
