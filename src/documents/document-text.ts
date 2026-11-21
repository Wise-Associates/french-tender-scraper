import { fork } from 'child_process';
import { join } from 'path';
import { pdfText } from './pdf-text';
import { docxText } from './word-text';

/** Formats whose text the analysis reads; the others are attached to the email only. */
export type TextFormat = 'pdf' | 'docx';

/** Per document: the documents seen in November 2026 were read in well under a second. */
export const EXTRACTION_TIMEOUT_MS = 20_000;

/** Text of a document, parsed in this process; errors come back as a rejection. Only the child process (extract-text.worker.ts) calls it. */
export async function documentText(format: TextFormat, content: Buffer, maxChars: number): Promise<string> {
  return format === 'pdf' ? pdfText(content, maxChars) : docxText(content, maxChars);
}

/**
 * Text of a document, parsed in a child process killed after `timeoutMs`.
 * The documents come from the site's buyers: pdf.js does not bound how far it
 * inflates a stream (a 1 MB PDF reached 2.2 GB in a test), and an archive
 * lying about its size keeps the CPU busy. In a child process neither blocks
 * the API (scheduler, healthcheck) nor takes its memory: the child marks
 * itself as the process the kernel kills first, and the document is reported
 * unreadable.
 */
export function extractTextIsolated(format: TextFormat, content: Buffer, maxChars: number, timeoutMs = EXTRACTION_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = fork(join(__dirname, 'extract-text.worker.js'), [], {
      serialization: 'advanced',
      // unpdf is an ES module loaded through require(): Node 22 warns about it in every child.
      execArgv: ['--max-old-space-size=256', '--disable-warning=ExperimentalWarning'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`lecture trop longue (plus de ${Math.round(timeoutMs / 1000)} s)`))), timeoutMs);
    child.once('message', (reply: { text?: unknown; error?: unknown }) =>
      finish(() => (typeof reply.text === 'string' ? resolve(reply.text) : reject(new Error(String(reply.error ?? 'réponse illisible'))))),
    );
    child.once('error', (err) => finish(() => reject(err)));
    child.once('exit', (code, signal) => finish(() => reject(new Error(`lecture interrompue (${signal ?? `code ${code}`}, mémoire dépassée ?)`))));
    child.send({ format, content, maxChars });
  });
}
