// unpdf publishes its types for ES modules only (package.json "exports"), which this CommonJS project's module
// resolution cannot read. Only what pdf-text.ts uses is declared here, from unpdf 1.9.1's index.d.mts (pdf.js
// PDFDocumentProxy, PDFPageProxy, TextContent). At run time Node loads the ES module through require()
// (Node ≥ 22.12; Node 22 prints an ExperimentalWarning once). Check these lines when upgrading unpdf.
declare module 'unpdf' {
  interface PdfTextItem {
    /** Absent on marked-content items. */
    str?: string;
    hasEOL?: boolean;
  }
  interface PdfPage {
    getTextContent(): Promise<{ items: PdfTextItem[] }>;
  }
  export interface PdfDocument {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfPage>;
    loadingTask: { destroy(): Promise<void> };
  }
  /** pdf.js getDocument(); `verbosity: 0` keeps its warnings out of the logs. */
  export function getDocumentProxy(data: Uint8Array, options?: { verbosity?: number }): Promise<PdfDocument>;
}
