// Picks the details out of a reply so they stand out: amounts ("1 USDC", "0.001 ETH", "$5") in one highlight, and
// addresses, ENS names, transaction hashes and request ids in another. Only plain and dim text is split; accent, status
// and marked text keep their own look. Links are left whole so the terminal can still open them.

import type { Line, Segment } from './repl.js';

/** "$5", "1 USDC", "0.001 ETH", and the token-first form the limits use ("USDC 100"). */
const AMOUNT = String.raw`(?:\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:USDC|ETH|USD|ether)\b|\b(?:USDC|ETH)\s\d[\d,]*(?:\.\d+)?\b)`;
const DETAIL = [
  String.raw`0x[0-9a-fA-F]{64}\b`,
  String.raw`0x[0-9a-fA-F]{40}\b`,
  String.raw`0x[0-9a-fA-F]{4,6}…[0-9a-fA-F]{4}\b`,
  String.raw`\breq_[0-9a-f]{12}\b`,
  String.raw`(?<![\w@.-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth\b`,
].join('|');
const URL_RE = String.raw`https?:\/\/\S+`;
/** One pass, leftmost match first: a link (kept), an amount, or a detail. */
const PATTERN = new RegExp(`(${URL_RE})|(${AMOUNT})|(${DETAIL})`, 'gi');

const cache = new WeakMap<Line, Line>();

function split(seg: Segment): Segment[] {
  if (seg.tone !== 0 && seg.tone !== 1) return [seg];
  const out: Segment[] = [];
  let at = 0;
  for (const m of seg.text.matchAll(PATTERN)) {
    if (m[1] !== undefined) continue;
    const start = m.index;
    if (start > at) out.push({ text: seg.text.slice(at, start), tone: seg.tone });
    out.push({ text: m[0], tone: m[2] !== undefined ? 8 : 7 });
    at = start + m[0].length;
  }
  if (at === 0) return [seg];
  if (at < seg.text.length) out.push({ text: seg.text.slice(at), tone: seg.tone });
  return out;
}

/** The line with its amounts and details highlighted (the same text, split into more segments). */
export function highlight(line: Line): Line {
  const known = cache.get(line);
  if (known) return known;
  const result = line.flatMap(split);
  cache.set(line, result);
  return result;
}
