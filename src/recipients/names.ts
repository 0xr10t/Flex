// Implements: §9.1 step 1 (name_key), §9.1 step 4 (close-contact chips: Levenshtein ≤ 2, top 3, by distance then
// alphabetically; I-30), §9.2 step 6 contact-name rules (I-29), §16.3 names typed by the user.

import { distance } from 'fastest-levenshtein';
import type { Db2Row, Repos } from '../contracts/repos.js';
import { BACK_REFERENCE_WORDS, TOKENS } from '../contracts/static-tables.js';
import type { Config } from '../contracts/types.js';

/** §9.1 step 1: trim, lowercase, collapse internal whitespace. */
export function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface CloseContact {
  name: string;
  name_key: string;
  distance: number;
}

/** §9.1 step 4: up to 3 contacts whose name_key is within Levenshtein distance ≤ 2, by distance then alphabetically. */
export function closeContacts(rows: Db2Row[], key: string): CloseContact[] {
  const byKey = new Map<string, string>();
  for (const r of rows) if (!byKey.has(r.name_key)) byKey.set(r.name_key, r.name);
  const out: CloseContact[] = [];
  for (const [k, name] of byKey) {
    const d = distance(key, k);
    if (d <= 2) out.push({ name, name_key: k, distance: d });
  }
  out.sort((a, b) => a.distance - b.distance || (a.name_key < b.name_key ? -1 : a.name_key > b.name_key ? 1 : 0));
  return out.slice(0, 3);
}

/** §9.2 step 6 charset and length: 1–32 characters from letters, digits, space, `.`, `-`, `_`. */
const NAME_RE = /^[\p{L}\p{Nd} ._-]{1,32}$/u;

export type NameCheck = { ok: true; name: string } | { ok: false; reason: 'invalid' | 'taken' };

/**
 * §9.2 step 6: 1–32 characters from letters, digits, space, `.`, `-`, `_`; not a chain alias, token alias,
 * back-reference word, or a string starting with `0x`; `name_key` not already used in DB2.
 * The answer is trimmed before checking; the stored name is the trimmed text.
 */
export function checkContactName(text: string, config: Config, repos: Repos): NameCheck {
  const name = text.trim();
  if (!NAME_RE.test(name)) return { ok: false, reason: 'invalid' };
  const key = nameKey(name);
  if (key.startsWith('0x')) return { ok: false, reason: 'invalid' };
  const chainAliases = config.chains.flatMap((c) => [c.name, ...c.aliases]).map(nameKey);
  if (chainAliases.includes(key)) return { ok: false, reason: 'invalid' };
  const tokenAliases = [...TOKENS.USDC.aliases, ...TOKENS.ETH.aliases, 'usdc', 'eth'].map(nameKey);
  if (tokenAliases.includes(key)) return { ok: false, reason: 'invalid' };
  if (BACK_REFERENCE_WORDS.map(nameKey).includes(key)) return { ok: false, reason: 'invalid' };
  if (repos.db2.findByNameKey(key).length > 0) return { ok: false, reason: 'taken' };
  return { ok: true, name };
}
