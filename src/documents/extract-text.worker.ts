// Child process started by extractTextIsolated (document-text.ts): reads one document sent over IPC, answers
// { text } or { error }, then exits. Never imported by the API.
import { writeFileSync } from 'fs';
import { documentText, TextFormat } from './document-text';

// Linux: when memory runs out in the container, the kernel kills this process rather than the API or Chromium.
// Raising one's own score needs no privilege. Elsewhere (Windows, macOS) the file does not exist, and the parent's
// time limit still bounds the parse.
try {
  writeFileSync('/proc/self/oom_score_adj', '1000');
} catch {
  // Not Linux, or /proc not mounted: nothing to adjust.
}

process.once('message', (message: { format: TextFormat; content: Uint8Array; maxChars: number }) => {
  const reply = (answer: { text: string } | { error: string }) => process.send?.(answer, () => process.exit(0));
  documentText(message.format, Buffer.from(message.content.buffer, message.content.byteOffset, message.content.byteLength), message.maxChars).then(
    (text) => reply({ text }),
    (err: unknown) => reply({ error: err instanceof Error ? err.message : String(err) }),
  );
});
