import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pdfText } from './pdf-text';
import { minimalPdf } from './test-documents';

describe('pdfText', () => {
  it('reads the text of a PDF and leaves the given bytes usable', async () => {
    const pdf = minimalPdf(['Cahier des charges fictif', 'Développeur Java (Kafka)']);
    assert.equal(await pdfText(pdf, 1000), 'Cahier des charges fictif\nDéveloppeur Java (Kafka)');
    assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')));
  });

  it('stops at the character limit', async () => {
    assert.equal(await pdfText(minimalPdf(['x'.repeat(500)]), 50), 'x'.repeat(50));
  });

  it('rejects a damaged PDF', async () => {
    await assert.rejects(pdfText(Buffer.from('%PDF-1.4\nnot a pdf'), 1000));
  });
});
