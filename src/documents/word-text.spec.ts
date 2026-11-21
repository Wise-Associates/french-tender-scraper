import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { minimalDocx, minimalPdf } from './test-documents';
import { docxText, MAX_DOCX_XML_BYTES, wordXmlText } from './word-text';

const xml = (body: string) => `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`;

describe('wordXmlText', () => {
  it('reads paragraphs, tabs and line breaks', () => {
    const body =
      '<w:p><w:r><w:t>Contexte</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Lieu :</w:t><w:tab/><w:t>Val de Fontenay</w:t><w:br/><w:t>2 jours sur site</w:t></w:r></w:p>';
    assert.equal(wordXmlText(xml(body), 1000), 'Contexte\nLieu :\tVal de Fontenay\n2 jours sur site');
  });

  it('decodes entities and skips what is not document text', () => {
    const body =
      '<w:p><w:r><w:t>R&amp;D &lt;Java&gt; &#233;t&#xE9; &#0;&#xD800;</w:t></w:r>' +
      '<w:r><w:instrText>HYPERLINK "x"</w:instrText><w:delText>supprimé</w:delText></w:r></w:p>';
    assert.equal(wordXmlText(xml(body), 1000), 'R&D <Java> été');
  });

  it('reads a text box once, not its fallback copy', () => {
    const box = '<w:t>Encadré</w:t>';
    const body = `<w:p><w:r><mc:AlternateContent><mc:Choice>${box}</mc:Choice><mc:Fallback>${box}</mc:Fallback></mc:AlternateContent></w:r></w:p>`;
    assert.equal(wordXmlText(xml(body), 1000), 'Encadré');
  });

  it('stops at the character limit', () => {
    const body = '<w:p><w:r><w:t>' + 'x'.repeat(5000) + '</w:t></w:r></w:p>';
    assert.equal(wordXmlText(xml(body), 100).length, 100);
  });

  it('stays fast on hostile markup', () => {
    const started = Date.now();
    wordXmlText('<'.repeat(2_000_000), 30_000);
    wordXmlText(`<w:t>${' '.repeat(2_000_000)}x</w:t>`, 30_000);
    wordXmlText('<w:t>' + '<w:tab/>'.repeat(500_000), 30_000);
    assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
  });
});

describe('docxText', () => {
  it('reads the body of a .docx', () => {
    assert.equal(docxText(minimalDocx(['Cahier des charges fictif', 'Développeur Java & Kafka']), 1000), 'Cahier des charges fictif\nDéveloppeur Java & Kafka');
  });

  it('refuses a file that is not a .docx', () => {
    assert.throws(() => docxText(minimalPdf(['x']), 1000));
    assert.throws(() => docxText(zipSync({ 'autre.xml': strToU8('<x/>') }), 1000), /no word\/document.xml/);
  });

  it('never inflates more than the archive declares, nor a declared size over the limit', () => {
    const lying = Buffer.from(zipSync({ 'word/document.xml': new Uint8Array(50 * 1024 * 1024) }, { level: 9 }));
    const declare = (archive: Buffer, size: number) => {
      const copy = Buffer.from(archive);
      for (let i = 0; i + 4 <= copy.length; i += 1) {
        if (copy.readUInt32LE(i) === 0x04034b50) copy.writeUInt32LE(size, i + 22); // local header
        if (copy.readUInt32LE(i) === 0x02014b50) copy.writeUInt32LE(size, i + 24); // central directory
      }
      return copy;
    };
    const before = process.memoryUsage().rss;
    assert.equal(docxText(declare(lying, 1024), 1000), '');
    assert.ok(process.memoryUsage().rss - before < 40 * 1024 * 1024);
    assert.throws(() => docxText(declare(lying, MAX_DOCX_XML_BYTES + 1), 1000), /over 20 MB/);
  });
});
