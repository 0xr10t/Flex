// Implements: §8.3 helpers shared by the lexical scan and S3/S5 (whole-word matching, ranges, clause lookup).
// Owner: Lane B.

import type { Clause } from '../contracts/types.js';

export interface Range {
  start: number;
  end: number;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_CHAR = 'A-Za-z0-9_';

/** Whole-word, case-insensitive regex for a phrase; internal spaces match any whitespace run. */
export function wordRe(phrases: readonly string[], extraSuffix = ''): RegExp {
  const alts = [...phrases]
    .sort((a, b) => b.length - a.length)
    .map((p) => escapeRe(p).replace(/\s+/g, '\\s+'))
    .join('|');
  return new RegExp(`(?<![${WORD_CHAR}])(?:${alts})${extraSuffix}(?![${WORD_CHAR}])`, 'gi');
}

export function overlaps(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

export function inside(inner: Range, outer: Range): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

export function overlapsAny(r: Range, list: readonly Range[]): boolean {
  return list.some((x) => overlaps(r, x));
}

/** Clause containing `offset`, else the next clause after it, else the last clause (0 when there are none). */
export function clauseIndexAt(clauses: readonly Clause[], offset: number): number {
  for (const c of clauses) if (offset >= c.start && offset < c.end) return c.index;
  for (const c of clauses) if (c.start >= offset) return c.index;
  const last = clauses[clauses.length - 1];
  return last ? last.index : 0;
}

/** The word immediately before `offset` (lower-cased), or null. */
export function wordBefore(text: string, offset: number): string | null {
  const m = /([A-Za-z0-9_]+)\W*$/.exec(text.slice(0, offset));
  return m?.[1] !== undefined ? m[1].toLowerCase() : null;
}

/** The word immediately after `offset` (lower-cased), or null. */
export function wordAfter(text: string, offset: number): string | null {
  const m = /^\W*?([A-Za-z0-9_]+)/.exec(text.slice(offset));
  return m?.[1] !== undefined ? m[1].toLowerCase() : null;
}

/** The whitespace-delimited token immediately before / after an offset (raw). */
export function tokenBefore(text: string, offset: number): string | null {
  const m = /(\S+)\s*$/.exec(text.slice(0, offset));
  return m?.[1] ?? null;
}
export function tokenAfter(text: string, offset: number): string | null {
  const m = /^\s*(\S+)/.exec(text.slice(offset));
  return m?.[1] ?? null;
}

/** True when `a` and `b` would join into one word or one number (letter–letter or digit–digit). */
function glued(a: string, b: string): boolean {
  return (/[A-Za-z]/.test(a) && /[A-Za-z]/.test(b)) || (/[0-9]/.test(a) && /[0-9]/.test(b));
}

/**
 * Finds `needle` in `haystack` at the first occurrence that does not overlap `used` (§8.4 rule 1 "first unused
 * occurrence"). With `wholeWord`, the occurrence must not cut a word or a number: no letter next to a letter and no
 * digit next to a digit at either edge ("5" is not found inside "50", "riya" not inside "riyaz", but "50" is found in
 * "50usdc"). spec-questions/B.md SQB-26.
 */
export function findUnused(haystack: string, needle: string, used: readonly Range[], wholeWord = false): Range | null {
  if (needle.length === 0) return null;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return null;
    const r = { start: i, end: i + needle.length };
    const okWord =
      !wholeWord ||
      (!glued(haystack[i - 1] ?? '', needle[0] ?? '') &&
        !glued(needle[needle.length - 1] ?? '', haystack[r.end] ?? ''));
    if (okWord && !overlapsAny(r, used)) return r;
    from = i + 1;
  }
}

/** Replaces ranges (non-overlapping) in `text` by the given strings. */
export function replaceRanges(text: string, reps: ReadonlyArray<Range & { with: string }>): string {
  const sorted = [...reps].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const r of sorted) {
    out += text.slice(pos, r.start) + r.with;
    pos = r.end;
  }
  return out + text.slice(pos);
}
