import { strFromU8, unzipSync } from 'fflate';

/**
 * Largest `word/document.xml` inflated, as declared by the archive. fflate
 * never inflates past the declared size (checked with an archive declaring
 * 1 KB for 50 MB), so this bounds the memory a hostile .docx can take.
 */
export const MAX_DOCX_XML_BYTES = 20 * 1024 * 1024;

/** Text of a .docx (the main document part only: no headers, footers or comments), at most `maxChars`. */
export function docxText(content: Uint8Array, maxChars: number): string {
  const files = unzipSync(content, {
    filter: (file) => file.name === 'word/document.xml' && file.originalSize <= MAX_DOCX_XML_BYTES,
  });
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('no word/document.xml in the archive, or over 20 MB');
  return wordXmlText(strFromU8(xml), maxChars);
}

const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|lt|gt|amp|quot|apos);/gi;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (entity, body: string) => {
    if (body[0] !== '#') return NAMED[body.toLowerCase()] ?? entity;
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

/**
 * Text of WordprocessingML (`word/document.xml`): the content of `<w:t>`
 * elements, a line per paragraph, tabs and line breaks kept. Text boxes are
 * stored twice by Word (`mc:Choice` and `mc:Fallback`): the fallback copy is
 * skipped. One pass with indexOf, no regular expression on the markup: the
 * time stays linear whatever the file contains.
 */
export function wordXmlText(xml: string, maxChars: number): string {
  const parts: string[] = [];
  let length = 0;
  let inText = false;
  let fallbackDepth = 0;
  const add = (text: string) => {
    if (fallbackDepth > 0 || !text) return;
    parts.push(text);
    length += text.length;
  };
  let position = 0;
  while (position < xml.length && length < maxChars) {
    const open = xml.indexOf('<', position);
    if (open === -1) break;
    if (inText && open > position) add(decodeEntities(xml.slice(position, open)));
    const close = xml.indexOf('>', open + 1);
    if (close === -1) break;
    const tag = xml.slice(open + 1, close);
    position = close + 1;
    const closing = tag.startsWith('/');
    const selfClosing = tag.endsWith('/');
    const name = tag.slice(closing ? 1 : 0).split(/[\s/]/, 1)[0];
    if (name === 'mc:Fallback') {
      if (closing) fallbackDepth = Math.max(0, fallbackDepth - 1);
      else if (!selfClosing) fallbackDepth += 1;
    } else if (name === 'w:t') {
      inText = !closing && !selfClosing;
    } else if (!closing && (name === 'w:tab' || name === 'w:ptab')) {
      add('\t');
    } else if (!closing && (name === 'w:br' || name === 'w:cr')) {
      add('\n');
    } else if (closing && name === 'w:p') {
      add('\n');
    }
  }
  // trimEnd per line rather than /[ \t]+\n/: that expression is quadratic on a long run of spaces.
  return parts
    .join('')
    .slice(0, maxChars)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
