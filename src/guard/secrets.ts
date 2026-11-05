// Implements: §8.2 step 2 secret scan — every detector of the table (raw private key, extended key, WIF key,
// Solana-style secret, seed phrase, keystore JSON), I-13 (12+ consecutive BIP-39 words block, checksum or not),
// I-14 (any 64-hex string blocks, tx hashes included). §5: @scure/bip39 English wordlist, @scure/base base58check.
// Pure functions: they never log, store or return the matched text.

import { createHash } from 'node:crypto';
import { base58, createBase58check } from '@scure/base';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export type SecretKind =
  'raw_private_key' | 'extended_key' | 'wif_key' | 'solana_secret' | 'seed_phrase' | 'keystore_json';

const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest());
const b58check = createBase58check(sha256);

const BIP39 = new Set(wordlist);

/** Raw private key: `(?<![0-9a-fA-F])(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])`. */
export function hasRawPrivateKey(text: string): boolean {
  return /(?<![0-9a-fA-F])(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(text);
}

function base58checkDecodes(s: string): Uint8Array | null {
  try {
    return b58check.decode(s);
  } catch {
    return null;
  }
}

/** Extended key: `\b[xyzt]prv[1-9A-HJ-NP-Za-km-z]{100,112}\b`, then base58check decode succeeds. */
export function hasExtendedKey(text: string): boolean {
  for (const m of text.matchAll(/\b[xyzt]prv[1-9A-HJ-NP-Za-km-z]{100,112}\b/g)) {
    if (base58checkDecodes(m[0]) !== null) return true;
  }
  return false;
}

/** WIF key: `\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b`, base58check decode succeeds, first byte 0x80. */
export function hasWifKey(text: string): boolean {
  for (const m of text.matchAll(/\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g)) {
    const bytes = base58checkDecodes(m[0]);
    if (bytes !== null && bytes[0] === 0x80) return true;
  }
  return false;
}

/** Solana-style secret: `\b[1-9A-HJ-NP-Za-km-z]{86,88}\b`, base58 decodes to 64 bytes. */
export function hasSolanaSecret(text: string): boolean {
  for (const m of text.matchAll(/\b[1-9A-HJ-NP-Za-km-z]{86,88}\b/g)) {
    try {
      if (base58.decode(m[0]).length === 64) return true;
    } catch {
      // not base58 → not this detector
    }
  }
  return false;
}

/**
 * Seed phrase: lowercase, split on non-letters; block if any run of consecutive words that are all in the BIP-39
 * English list has length ≥ 12 (whether or not a window passes validateMnemonic: a mistyped seed is still a secret).
 */
export function hasSeedPhrase(text: string): boolean {
  const words = text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 0);
  let run = 0;
  for (const w of words) {
    if (BIP39.has(w)) {
      run++;
      if (run >= 12) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

function collectKeys(v: unknown, depth: number, out: Set<string>): void {
  if (depth > 16 || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    for (const x of v) collectKeys(x, depth + 1, out);
    return;
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out.add(k);
    collectKeys(x, depth + 1, out);
  }
}

function hasKeystoreKeys(v: unknown): boolean {
  const keys = new Set<string>();
  collectKeys(v, 0, keys);
  return (keys.has('crypto') || keys.has('Crypto')) && keys.has('ciphertext') && keys.has('kdf');
}

/** Keystore JSON: JSON-parsable text containing keys `crypto` (or `Crypto`), `ciphertext` and `kdf`. */
export function hasKeystoreJson(text: string): boolean {
  const candidates = [text.trim()];
  // A keystore may be embedded in a longer text block: also try the outermost {...} span.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    if (!c.startsWith('{') && !c.startsWith('[')) continue;
    try {
      if (hasKeystoreKeys(JSON.parse(c) as unknown)) return true;
    } catch {
      // not JSON
    }
  }
  return false;
}

const DETECTORS: ReadonlyArray<[SecretKind, (t: string) => boolean]> = [
  ['raw_private_key', hasRawPrivateKey],
  ['extended_key', hasExtendedKey],
  ['wif_key', hasWifKey],
  ['solana_secret', hasSolanaSecret],
  ['seed_phrase', hasSeedPhrase],
  ['keystore_json', hasKeystoreJson],
];

/** Returns the first detector that fires, or null. Never returns the matched text. */
export function detectSecret(text: string): SecretKind | null {
  for (const [kind, fn] of DETECTORS) if (fn(text)) return kind;
  return null;
}
