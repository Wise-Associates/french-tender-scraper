import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { documentsOf } from './send-offers';

// Fictitious links; the downloader is a fake.
const links = [
  { name: 'cdc.pdf', url: 'https://partenaire-gc.com/system/files/cdc.pdf' },
  { name: 'annexe.docx', url: 'https://partenaire-gc.com/system/files/annexe.docx' },
];

describe('documentsOf', () => {
  it('asks for nothing when the offer has no documents', async () => {
    let called = false;
    const documents = await documentsOf([], async () => {
      called = true;
      return { attachments: [], notAttached: [] };
    });
    assert.deepEqual(documents, { attachments: [], notAttached: [] });
    assert.equal(called, false);
  });

  it('returns what the downloader gives', async () => {
    const result = { attachments: [{ filename: 'cdc.pdf', content: Buffer.from('%PDF-'), contentType: 'application/pdf' }], notAttached: [] };
    assert.equal(await documentsOf(links, async () => result), result);
  });

  it('lists the documents when they cannot be downloaded, so the offer is sent anyway', async () => {
    const failing = await documentsOf(links, async () => {
      throw new Error('Executable doesn’t exist at /ms-playwright/chromium');
    });
    assert.deepEqual(failing.attachments, []);
    assert.deepEqual(failing.notAttached.map((d) => d.name), ['cdc.pdf', 'annexe.docx']);
    assert.match(failing.notAttached[0].reason, /^téléchargement impossible \(Executable doesn’t exist/);
    const without = await documentsOf(links, undefined);
    assert.match(without.notAttached[1].reason, /^non téléchargé/);
  });
});
