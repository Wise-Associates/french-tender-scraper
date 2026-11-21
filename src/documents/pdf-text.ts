import { getDocumentProxy } from 'unpdf';

/** Pages read for the analysis: a cahier des charges states the mission in its first pages. */
export const MAX_PDF_PAGES = 40;

/**
 * Text of a PDF's first pages, at most `maxChars`; '' for a scanned PDF (no
 * text layer). pdf.js may take over the bytes it is given, so it works on a
 * copy: the caller's Buffer stays usable (e.g. as an email attachment).
 */
export async function pdfText(content: Buffer, maxChars: number): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(content), { verbosity: 0 });
  try {
    const pages: string[] = [];
    let length = 0;
    for (let number = 1; number <= Math.min(pdf.numPages, MAX_PDF_PAGES) && length < maxChars; number += 1) {
      const { items } = await (await pdf.getPage(number)).getTextContent();
      const text = items.map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : '')).join('');
      pages.push(text);
      length += text.length;
    }
    return pages.join('\n').slice(0, maxChars).trim();
  } finally {
    await pdf.loadingTask.destroy();
  }
}
