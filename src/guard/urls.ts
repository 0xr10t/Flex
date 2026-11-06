// Implements: §8.2 step 1 — every URL in `urls[]`, plus every `https://…` URL found in the typed text; URLs found in
// typed text are removed from `typed_text` and replaced by `[link N]`; `http://` URLs → URL_FETCH_FAILED. I-17.
// Link numbers: `urls[]` entries are links 1…u, typed URLs continue from u+1 in order of appearance
// (SQB-02).
// SQ-O-06 (human, 2026-11-06): every `urls[]` entry and every redirect target is secret-scanned before it is fetched.
// Owner: Lane B.

import type { FetchResult } from '../contracts/io.js';
import { LINK_MARKER } from '../quarantine/labels.js';
import { detectSecret } from './secrets.js';

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

function safeDecode(s: string): string {
  // Decode each run of percent-encoded bytes tolerantly. An unrelated stray '%' or invalid UTF-8 byte must not
  // hide a valid encoded secret elsewhere in the URL (B15). Literal Unicode and malformed escapes stay intact.
  return s
    .replace(/\+/g, ' ')
    .replace(/(?:%[0-9a-f]{2})+/gi, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'));
}

/** SQ-O-06: true when the URL, as written or percent-decoded, carries a secret (§8.2 step 2 detectors). */
export function urlHasSecret(url: string): boolean {
  return detectSecret(url) !== null || detectSecret(safeDecode(url)) !== null;
}

/**
 * SQ-O-06: the fetcher's refusal when a redirect target carries a secret. To the `ContentFetcher` contract it is a
 * plain `{ ok: false }`; S1 tells it apart with `isSecretRefusal` and answers SECRET_DETECTED.
 */
export function secretRefusal(): FetchResult {
  const r: { ok: false; secret: true } = { ok: false, secret: true };
  return r;
}

export function isSecretRefusal(r: FetchResult): boolean {
  return !r.ok && (r as { secret?: unknown }).secret === true;
}
