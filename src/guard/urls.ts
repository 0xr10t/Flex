// Implements: §8.2 step 1 — every URL in `urls[]`, plus every `https://…` URL found in the typed text; URLs found in
// typed text are removed from `typed_text` and replaced by `[link N]`; `http://` URLs → URL_FETCH_FAILED. I-17.
// Link numbers: `urls[]` entries are links 1…u, typed URLs continue from u+1 in order of appearance
// (spec-questions/B.md SQB-02).
// Owner: Lane B.

import { LINK_MARKER } from '../quarantine/labels.js';

export interface LinkRef {
  /** 1-based link number used in `[link N]` and URL_FETCH_FAILED. */
  n: number;
  url: string;
  from_typed_text: boolean;
}

const TYPED_URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/**
 * Sentence punctuation directly after a URL is not part of it. A closing bracket is kept when it closes an opener
 * inside the URL ("…/Foo_(bar)").
 */
function trimTrailing(url: string): string {
  let u = url;
  for (;;) {
    const last = u[u.length - 1] ?? '';
    const opener = CLOSERS[last];
    if (opener !== undefined) {
      if (count(u, opener) >= count(u, last)) return u;
    } else if (!'.,;:!?'.includes(last) || last === '') {
      return u;
    }
    u = u.slice(0, -1);
  }
}

export interface UrlExtraction {
  typed_text: string;
  links: LinkRef[];
}

export function extractUrls(text: string, urls: readonly string[]): UrlExtraction {
  const links: LinkRef[] = urls.map((url, i) => ({ n: i + 1, url, from_typed_text: false }));
  let out = '';
  let pos = 0;
  for (const m of text.matchAll(TYPED_URL_RE)) {
    const url = trimTrailing(m[0]);
    const start = m.index;
    const n = links.length + 1;
    links.push({ n, url, from_typed_text: true });
    out += text.slice(pos, start) + LINK_MARKER(n);
    pos = start + url.length;
  }
  out += text.slice(pos);
  return { typed_text: out, links };
}

export function isHttpsUrl(url: string): boolean {
  return /^https:\/\//i.test(url.trim());
}
