import type { Entry } from './repl.js';
export interface Selection {
  kind: 'input' | 'transcript';
  anchor: number;
  focus: number;
}
export const bounds = (s: Selection): [number, number] => [Math.min(s.anchor, s.focus), Math.max(s.anchor, s.focus)];
export interface TextRow {
  start: number;
  end: number;
  prefix: number;
}
/** Maps painted cells to original text offsets. Soft wraps and prompt marks never enter copied text. */
export function transcriptMap(entries: readonly Entry[], width: number): { chars: string[]; rows: TextRow[] } {
  const chars: string[] = [];
  const rows: TextRow[] = [];
  entries.forEach((entry, i) => {
    if (i) {
      chars.push('\n');
      rows.push({ start: chars.length, end: chars.length, prefix: 0 });
      chars.push('\n');
    }
    const lines =
      entry.kind === 'note' ? [entry.line] : entry.kind === 'user' ? [[{ text: entry.text, tone: 0 }]] : entry.lines;
    const prefix = entry.kind === 'note' ? 0 : 2;
    const capacity = Math.max(1, width - prefix);
    lines.forEach((line, j) => {
      if (j) chars.push('\n');
      const text = line.flatMap((s) => [...s.text].map((c) => (isControl(c) ? ' ' : c)));
      const start = chars.length;
      for (const char of text) chars.push(char);
      for (let k = 0; k < Math.max(1, text.length); k += capacity)
        rows.push({ start: start + k, end: start + Math.min(text.length, k + capacity), prefix });
    });
  });
  return { chars, rows };
}
function isControl(char: string): boolean {
  const code = char.codePointAt(0)!;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}
export const pasteText = (text: string): string =>
  [...text]
    .filter((c) => !isControl(c) || c === '\t' || c === '\r' || c === '\n')
    .join('')
    .replace(/\s+/g, ' ');
