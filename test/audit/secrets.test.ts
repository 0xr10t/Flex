// Phase 3 audit (§3.2): S1 secret detectors (every row of the §8.2 table, plus negatives) and "nothing is written".
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createBase58check, base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { detectSecret } from '../../src/guard/secrets.js';
import { Harness } from '../acceptance/harness.js';

const sha256 = (d: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(d).digest());
const b58c = createBase58check(sha256);
const rnd = (n: number): Uint8Array => new Uint8Array(randomBytes(n));
const cat = (...p: Uint8Array[]): Uint8Array => Uint8Array.from(p.flatMap((x) => [...x]));

function until<T>(make: () => T, ok: (v: T) => boolean): T {
  for (let i = 0; i < 500; i++) {
    const v = make();
    if (ok(v)) return v;
  }
  throw new Error('generator exhausted');
}

const HEX64 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const XPRV = b58c.encode(cat(Uint8Array.of(0x04, 0x88, 0xad, 0xe4), rnd(74)));
const WIF = until(
  () => b58c.encode(cat(Uint8Array.of(0x80), rnd(32))),
  (s) => /^[5KL]/.test(s) && s.length >= 51,
);
const WIF_COMPRESSED = until(
  () => b58c.encode(cat(Uint8Array.of(0x80), rnd(32), Uint8Array.of(1))),
  (s) => /^[5KL]/.test(s),
);
const SOL = until(
  () => base58.encode(rnd(64)),
  (s) => s.length >= 86 && s.length <= 88,
);
const SEED12 = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const KEYSTORE = JSON.stringify({ version: 3, id: 'x', Crypto: { ciphertext: 'ab', kdf: 'scrypt', mac: 'cd' } });

describe('S1 secret detectors — positives (§8.2 table, I-13, I-14)', () => {
  const cases: Array<[string, string, string]> = [
    ['raw key', `my key ${HEX64} ok`, 'raw_private_key'],
    ['raw key 0x', `0x${HEX64}`, 'raw_private_key'],
    ['tx hash (I-14)', `0x${'ef'.repeat(32)}`, 'raw_private_key'],
    ['xprv', `use ${XPRV} now`, 'extended_key'],
    ['WIF 51', `k ${WIF}`, 'wif_key'],
    ['WIF compressed 52', `k ${WIF_COMPRESSED}`, 'wif_key'],
    ['solana secret', `s ${SOL} end`, 'solana_secret'],
    ['seed 12', `seed: ${SEED12} thanks`, 'seed_phrase'],
    ['seed 12 uppercase, commas', SEED12.toUpperCase().replace(/ /g, ', '), 'seed_phrase'],
    ['seed 13 words, invalid checksum', `${SEED12} zoo`, 'seed_phrase'],
    ['keystore', KEYSTORE, 'keystore_json'],
    ['keystore embedded in text', `here: ${KEYSTORE} thanks`, 'keystore_json'],
  ];
  it.each(cases)('%s', (_n, text, kind) => {
    expect(detectSecret(text)).toBe(kind);
  });
});

describe('S1 secret detectors — negatives', () => {
  const badXprv = XPRV.slice(0, -1) + (XPRV.endsWith('1') ? '2' : '1');
  const badWif = WIF.slice(0, -1) + (WIF.endsWith('1') ? '2' : '1');
  const wif81 = until(
    () => b58c.encode(cat(Uint8Array.of(0x81), rnd(32))),
    (s) => /^[5KL]/.test(s) && s.length >= 51,
  );
  const sol63 = until(
    () => base58.encode(rnd(63)),
    (s) => s.length >= 86 && s.length <= 88,
  );
  const cases: Array<[string, string]> = [
    ['plain request', 'Send 50 USDc to ARADHYA on base'],
    ['63 hex', HEX64.slice(1)],
    ['65 hex', HEX64 + 'a'],
    ['40-hex address', '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E'],
    ['xprv with bad checksum', badXprv],
    ['WIF with bad checksum', badWif],
    ['WIF-shaped, first byte 0x81', wif81],
    ['86-88 char base58 decoding to 63 bytes', sol63],
    ['11 BIP-39 words', SEED12.split(' ').slice(0, 11).join(' ')],
    ['12 words with one non-BIP-39 word inside', SEED12.split(' ').toSpliced(6, 0, 'qwerty').join(' ')],
    [
      'two runs of 11',
      `${SEED12.split(' ').slice(0, 11).join(' ')} qwerty ${SEED12.split(' ').slice(0, 11).join(' ')}`,
    ],
    ['JSON without kdf', JSON.stringify({ crypto: { ciphertext: 'x' } })],
    ['JSON without ciphertext', JSON.stringify({ Crypto: { kdf: 'x' } })],
    ['words crypto/ciphertext/kdf in prose', 'crypto ciphertext kdf'],
  ];
  it.each(cases)('%s', (_n, text) => {
    expect(detectSecret(text)).toBeNull();
  });

  it('OBS (spec-conformant): a 64-hex key split by a space or hyphen is not detected', () => {
    // The §8.2 regex needs 64 consecutive hex digits; a user can paste a key in two halves. Not a lane defect.
    expect(detectSecret(`${HEX64.slice(0, 32)} ${HEX64.slice(32)}`)).toBeNull();
    expect(detectSecret(`${HEX64.slice(0, 32)}-${HEX64.slice(32)}`)).toBeNull();
  });
});

describe('S1 hit writes nothing (§8.2 step 2, A-16)', () => {
  const SESSION = ['db1_amount_placeholders', 'db3_address_placeholders', 'db8_prompts', 'db8_history'];
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

  const variants: Array<[string, string, Parameters<Harness['say']>[1], string]> = [
    ['typed text', `send 5 usdc to mihir, key ${HEX64}`, {}, HEX64],
    ['pasted block', 'pay this', { pasted_blocks: [`note ${SEED12}`] }, 'abandon ability'],
    [
      'attachment (text/plain)',
      'pay this',
      { attachments: [{ filename: 'k.txt', mime: 'text/plain', base64: b64(`wif ${WIF}`) }] },
      WIF,
    ],
    ['pasted keystore', 'pay this', { pasted_blocks: [KEYSTORE] }, 'scrypt'],
    ['pasted xprv', 'pay this', { pasted_blocks: [XPRV] }, XPRV],
    ['pasted solana secret', 'pay this', { pasted_blocks: [SOL] }, SOL],
  ];

  it.each(variants)(
    '%s: SECRET_DETECTED, DB1/DB3/DB8 empty, no model call, nothing in logs or response',
    async (_n, text, extra, needle) => {
      const h = new Harness('audit-secret', { calls: [] }, {});
      const r = await h.say(text, extra);
      expect(r.body.state).toBe('error');
      expect(r.body.error?.code).toBe('SECRET_DETECTED');
      for (const t of SESSION) expect(h.count(t), t).toBe(0);
      expect(h.llm.recorded).toEqual([]);
      expect(h.exec.submissions).toEqual([]);
      expect(JSON.stringify(r.body)).not.toContain(needle);
      const log = readFileSync(h.logFile, 'utf8');
      expect(log).not.toContain(needle);
      expect(log).not.toMatch(/mihir|pay this/i);
      await h.finish();
    },
  );

  it('http:// link or unsupported attachment stop before any write too', async () => {
    const h = new Harness('audit-secret2', { calls: [] }, {});
    const r = await h.say('read http://example.com/x');
    expect(r.body.error?.code).toBe('URL_FETCH_FAILED');
    for (const t of SESSION) expect(h.count(t), t).toBe(0);
    await h.finish();
  });
});

describe('S1 URL channel', () => {
  const KEY_URL = `https://example.com/collect?k=${HEX64}`;

  it('OBS characterisation: a secret inside urls[] is not scanned and the URL is fetched (spec §8.2 step 2 scans only typed text, pasted blocks, attachments)', async () => {
    const h = new Harness('audit-url-char', { calls: [] }, {});
    h.fetcher.pages.set(KEY_URL, { ok: false });
    const r = await h.say('read this', { urls: [KEY_URL] });
    expect(r.body.error?.code).toBe('URL_FETCH_FAILED');
    expect(h.fetcher.calls).toEqual([KEY_URL]); // the key left the process in an HTTPS GET
    await h.finish();
  });

  // Documents a §16.2 / §16.4 violation: a key the user put in urls[] is sent to an arbitrary host.
  it.fails('a secret in urls[] must be blocked before any fetch (SECRET_DETECTED, no outbound request)', async () => {
    const h = new Harness('audit-url', { calls: [] }, {});
    const r = await h.say('read this', { urls: [KEY_URL] });
    expect(r.body.error?.code).toBe('SECRET_DETECTED');
    expect(h.fetcher.calls).toEqual([]);
    await h.finish();
  });

  it('a secret in a URL typed in the text IS blocked before any fetch', async () => {
    const h = new Harness('audit-url-typed', { calls: [] }, {});
    const r = await h.say(`read ${KEY_URL}`);
    expect(r.body.error?.code).toBe('SECRET_DETECTED');
    expect(h.fetcher.calls).toEqual([]);
    await h.finish();
  });
});
