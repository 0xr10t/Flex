// Implements: SQ-O-01 / SQB-23 (human, 2026-11-06, option (b)): every further whole-word occurrence of a tagged span's
// text in the masked text is replaced by that span's placeholder (payee: its `address_…`/`group_…` placeholder;
// mentioned: `[person]`), so no copy of a recipient or mentioned name reaches LLM #4 (§16.1). No new DB3 row and no
// extra payment: swept occurrences reuse the span's placeholder. Matching is case-insensitive and whole-word (SQ-R-01:
// "Mihirs", "Mihir2" and a part of a multi-word name are not swept; Unicode-aware, R3-3); only exact, non-overlapping occurrences are swept: an occurrence inside another tagged span or
// inside a placeholder is left alone. A text tagged with both roles is not swept (F-12: S5 asks Q_NAME_ROLE first).
// Owner: Lane B (applied by S7, Lane C).

import { PLACEHOLDER_TOKEN_RE } from './patterns.js';
import { escapeRe, isIdentifierAt, overlapsAny, type Range } from './text.js';

/** One masking: `text` is the exact slice of the source at [start, end), replaced by `with`. */
export interface Masking extends Range {
  text: string;
  with: string;
}

export const PERSON = '[person]';

/** Case and whitespace-run insensitive key of a span text. */
export const nameKey = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

/** Regex source for one span text: the original text escaped (not lower-cased), whitespace runs as `\s+`. */
const textSource = (text: string): string => escapeRe(text.trim()).replace(/\s+/g, '\\s+');

/**
 * Extra maskings for the untagged repeats of the tagged texts in `source`. `tagged` is not changed. `unplaced` are
 * texts to sweep that have no range of their own in `source` (a payee removed in S6 without a typed span, R2 gap).
 * The regex is built from the original span text with the `giu` flags (R3-3): lower-casing first breaks names whose
 * lower-case form has another length ("İrem" → "i̇rem").
 */
export function sweepRepeats(
  source: string,
  tagged: readonly Masking[],
  unplaced: ReadonlyArray<{ text: string; with: string }> = [],
): Masking[] {
  const byKey = new Map<string, Array<{ text: string; with: string; start: number }>>();
  const add = (t: { text: string; with: string; start: number }): void => {
    const key = nameKey(t.text);
    if (key.length > 0) byKey.set(key, [...(byKey.get(key) ?? []), t]);
  };
  for (const t of tagged) add(t);
  for (const u of unplaced) add({ ...u, start: Number.POSITIVE_INFINITY });
  const taken: Range[] = [
    ...tagged,
    ...[...source.matchAll(PLACEHOLDER_TOKEN_RE)].map((m) => ({ start: m.index, end: m.index + m[0].length })),
  ];
  const out: Masking[] = [];
  // Longer texts first, so a repeat of "Riya Shah" is swept whole before "Riya" could cut it.
  for (const [, group] of [...byKey].sort((a, b) => b[0].length - a[0].length)) {
    if (new Set(group.map((g) => g.with === PERSON)).size > 1) continue; // both roles: F-12 decides
    // Several spans of one text: the earliest span's placeholder (one name is one contact, D-11).
    const first = group.reduce((a, b) => (b.start < a.start ? b : a));
    const alts = [...new Set(group.map((g) => textSource(g.text)))].sort((a, b) => b.length - a.length);
    const re = new RegExp(alts.join('|'), 'giu');
    for (let m = re.exec(source); m !== null; m = re.exec(source)) {
      const r = { start: m.index, end: m.index + m[0].length };
      if (isIdentifierAt(source, r) && !overlapsAny(r, taken)) {
        out.push({ ...r, text: m[0], with: first.with });
        taken.push(r);
      } else {
        re.lastIndex = m.index + 1;
      }
    }
  }
  return out;
}
