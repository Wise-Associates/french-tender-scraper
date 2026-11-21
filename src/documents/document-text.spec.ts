import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractTextIsolated } from './document-text';
import { minimalDocx, minimalPdf } from './test-documents';

describe('extractTextIsolated', () => {
  it('reads PDF and Word documents in a child process', async () => {
    assert.equal(await extractTextIsolated('pdf', minimalPdf(['Cahier des charges fictif']), 1000), 'Cahier des charges fictif');
    assert.equal(await extractTextIsolated('docx', minimalDocx(['Annexe fictive']), 1000), 'Annexe fictive');
  });

  it('passes the parser\'s error back', async () => {
    await assert.rejects(extractTextIsolated('pdf', Buffer.from('%PDF-1.4\nrien'), 1000), /Invalid PDF structure/);
    await assert.rejects(extractTextIsolated('docx', minimalPdf(['x']), 1000), /zip/i);
  });

  it('kills the child process after the time limit', async () => {
    const started = Date.now();
    await assert.rejects(extractTextIsolated('pdf', minimalPdf(['x']), 1000, 1), /lecture trop longue/);
    assert.ok(Date.now() - started < 1_000);
  });
});
