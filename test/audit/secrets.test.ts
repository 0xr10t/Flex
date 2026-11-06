// Phase 3 audit (§3.2): S1 secret detectors (every row of the §8.2 table, plus negatives) and "nothing is written".
// Extended-key privacy hardening: generated synthetic keys only, across every user-input channel and answers.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createBase58check, base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { detectSecret } from '../../src/guard/secrets.js';
import { isSecretRefusal, secretRefusal } from '../../src/guard/urls.js';
import { createContentFetcher } from '../../src/quarantine/fetch.js';
import { testConfig } from '../fakes/context.js';
import { Harness, loadFixture } from '../acceptance/harness.js';

const sha256 = (d: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(d).digest());
const b58c = createBase58check(sha256);
const rnd = (n: number): Uint8Array => new Uint8Array(randomBytes(n));
const cat = (...p: Uint8Array[]): Uint8Array => Uint8Array.from(p.flatMap((x) => [...x]));

function extendedKey(version: number, publicKey = false): string {
  const payload = new Uint8Array(78);
  new DataView(payload.buffer).setUint32(0, version);
  payload.fill(0x42, 13, 45);
  payload[45] = publicKey ? 0x02 : 0x00;
  payload[77] = 0x01;
  return b58c.encode(payload);
}

const PRIVATE_VERSIONS = [
  ['xprv', 0x0488ade4],
  ['yprv', 0x049d7878],
  ['zprv', 0x04b2430c],
  ['tprv', 0x04358394],
  ['uprv', 0x044a4e28],
  ['vprv', 0x045f18bc],
  ['Yprv', 0x0295b005],
  ['Zprv', 0x02aa7a99],
  ['Uprv', 0x024285b5],
  ['Vprv', 0x02575048],
] as const;
const PUBLIC_VERSIONS = [
  ['xpub', 0x0488b21e],
  ['ypub', 0x049d7cb2],
  ['zpub', 0x04b24746],
  ['tpub', 0x043587cf],
  ['upub', 0x044a5262],
  ['vpub', 0x045f1cf6],
] as const;

function until<T>(make: () => T, ok: (v: T) => boolean): T {
  for (let i = 0; i < 500; i++) {
    const v = make();
    if (ok(v)) return v;
  }
  throw new Error('generator exhausted');
}

const HEX64 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const XPRV = extendedKey(0x0488ade4);
const WRAPPED_XPRV = `0x${XPRV}`;
const BAD_XPRV = XPRV.slice(0, -1) + (XPRV.endsWith('1') ? '2' : '1');
const MALFORMED_XPRV = XPRV.slice(0, 30) + '0' + XPRV.slice(31);
const percentEncode = (text: string): string =>
  [...Buffer.from(text)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
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
    ['0x-prefixed xprv', WRAPPED_XPRV, 'extended_key'],
    ['xprv with bad checksum', `0x${BAD_XPRV}`, 'extended_key'],
    ['xprv with invalid base58 alphabet', MALFORMED_XPRV, 'extended_key'],
    ['uppercase extended private key', XPRV.toUpperCase(), 'extended_key'],
    ['extended key with adjacent framing', `backup_${XPRV}_end`, 'extended_key'],
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

  it.each(PRIVATE_VERSIONS)(
    'synthetic valid %s stays private with a directly adjacent 0x prefix',
    (prefix, version) => {
      const key = extendedKey(version);
      expect(key.startsWith(prefix)).toBe(true);
      expect(b58c.decode(key)).toHaveLength(78);
      expect(detectSecret(`0x${key}`)).toBe('extended_key');
    },
  );
});

describe('S1 secret detectors — negatives', () => {
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
    ['short extended-key mention', 'Please explain xprv, yprv, zprv, tprv, uprv and vprv.'],
    ['short extended-key example', `xprv${'a'.repeat(20)}`],
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

  it.each(PUBLIC_VERSIONS)('synthetic valid extended public key %s remains allowed', (prefix, version) => {
    const key = extendedKey(version, true);
    expect(key.startsWith(prefix)).toBe(true);
    expect(b58c.decode(key)).toHaveLength(78);
    expect(detectSecret(`0x${key}`)).toBeNull();
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
    ['typed 0x-prefixed xprv', `use ${WRAPPED_XPRV}`, {}, XPRV],
    ['pasted 0x-prefixed xprv', 'pay this', { pasted_blocks: [WRAPPED_XPRV] }, XPRV],
    ['typed extended key with bad checksum', `use 0x${BAD_XPRV}`, {}, BAD_XPRV],
    ['pasted extended key with invalid alphabet', 'pay this', { pasted_blocks: [MALFORMED_XPRV] }, MALFORMED_XPRV],
    [
      'attachment with 0x-prefixed xprv',
      'pay this',
      { attachments: [{ filename: 'synthetic.txt', mime: 'text/plain', base64: b64(WRAPPED_XPRV) }] },
      XPRV,
    ],
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
      expect(h.fetcher.calls).toEqual([]);
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

  // SQ-O-06 (human): a key the user put in urls[] is never sent to a host.
  it('SQ-O-06: a secret in urls[] is blocked before any fetch (SECRET_DETECTED, no outbound request, nothing written)', async () => {
    const h = new Harness('audit-url', { calls: [] }, {});
    const r = await h.say('read this', { urls: [KEY_URL] });
    expect(r.body.state).toBe('error');
    expect(r.body.error?.code).toBe('SECRET_DETECTED');
    expect(h.fetcher.calls).toEqual([]);
    for (const t of ['db1_amount_placeholders', 'db3_address_placeholders', 'db8_prompts', 'db8_history'])
      expect(h.count(t), t).toBe(0);
    expect(h.llm.recorded).toEqual([]);
    expect(JSON.stringify(r.body)).not.toContain(HEX64);
    expect(readFileSync(h.logFile, 'utf8')).not.toContain(HEX64);
    await h.finish();
  });

  it('SQ-O-06: a fetcher that refuses with secretRefusal() (redirect target carried a key) -> SECRET_DETECTED, nothing stored or logged', async () => {
    const h = new Harness('audit-url-redirect', { calls: [] }, {});
    const clean = 'https://a.example.com/start';
    h.fetcher.pages.set(clean, secretRefusal());
    const r = await h.say('read this', { urls: [clean] });
    expect(r.body.error?.code).toBe('SECRET_DETECTED');
    for (const t of ['db1_amount_placeholders', 'db3_address_placeholders', 'db8_prompts', 'db8_history'])
      expect(h.count(t), t).toBe(0);
    expect(h.llm.recorded).toEqual([]);
    expect(readFileSync(h.logFile, 'utf8')).not.toContain('a.example.com');
    await h.finish();
  });

  it('SQ-O-06: the production fetcher never requests a redirect target that carries a key', async () => {
    const cfg = testConfig();
    const requested: string[] = [];
    const f = createContentFetcher(cfg, {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      httpGet: async (url) => {
        requested.push(url.href);
        return {
          status: 302,
          headers: { location: `https://b.example.com/?k=${HEX64}` },
          body: (async function* () {})(),
          destroy: () => undefined,
        };
      },
    });
    const res = await f.fetchUrl('https://a.example.com/');
    expect(isSecretRefusal(res)).toBe(true);
    expect(requested).toEqual(['https://a.example.com/']);
  });

  it('a secret in a URL typed in the text IS blocked before any fetch', async () => {
    const h = new Harness('audit-url-typed', { calls: [] }, {});
    const r = await h.say(`read ${KEY_URL}`);
    expect(r.body.error?.code).toBe('SECRET_DETECTED');
    expect(h.fetcher.calls).toEqual([]);
    await h.finish();
  });

  it.each([
    { channel: 'inline', encoded: false },
    { channel: 'explicit', encoded: false },
    { channel: 'inline', encoded: true },
    { channel: 'explicit', encoded: true },
  ])(
    '0x-prefixed extended key in $channel URL, encoded=$encoded, is blocked before IO or storage',
    async ({ channel, encoded }) => {
      const value = encoded ? percentEncode(WRAPPED_XPRV) : WRAPPED_XPRV;
      const url = `https://example.com/collect?key=${value}`;
      const h = new Harness('audit-extended-url', { calls: [] }, {});
      try {
        const response = channel === 'inline' ? await h.say(`read ${url}`) : await h.say('read this', { urls: [url] });
        expect(response.body.error?.code).toBe('SECRET_DETECTED');
        expect(h.fetcher.calls).toEqual([]);
        expect(h.llm.recorded).toEqual([]);
        expect(h.exec.submissions).toEqual([]);
        for (const table of [
          'db1_amount_placeholders',
          'db3_address_placeholders',
          'db8_prompts',
          'db8_history',
          'db6_spend_log',
          'db7_autopays',
          'handoff_journal',
        ]) {
          expect(h.count(table), table).toBe(0);
        }
        for (const output of [JSON.stringify(response.body), readFileSync(h.logFile, 'utf8')]) {
          expect(output).not.toContain(XPRV);
          expect(output).not.toContain(value);
          expect(output).not.toContain('example.com');
        }
      } finally {
        await h.finish();
      }
    },
  );
});

describe('Extended private keys in answers are blocked before answer persistence or downstream IO', () => {
  it.each([
    { channel: 'answers', encoding: 'raw' },
    { channel: 'messages', encoding: 'raw' },
    { channel: 'answers', encoding: 'encoded-url' },
    { channel: 'messages', encoding: 'encoded-url' },
  ])('$channel endpoint, $encoding input', async ({ channel, encoding }) => {
    const h = new Harness(
      'audit-extended-answer',
      { calls: loadFixture('A-01').calls.slice(0, 3) },
      { contacts: false },
    );
    try {
      const initial = await h.say('Send 50 USDc to ARADHYA');
      expect(initial.body.question?.code).toBe('Q_WHO_IS');
      const tables = [
        'db1_amount_placeholders',
        'db3_address_placeholders',
        'db8_prompts',
        'db8_history',
        'db6_spend_log',
        'db7_autopays',
        'handoff_journal',
      ];
      const before = h.snapshot(tables);
      const calls = structuredClone(h.llm.recorded);
      const text = encoding === 'raw' ? WRAPPED_XPRV : `https://example.com/?key=${percentEncode(WRAPPED_XPRV)}`;
      const response = channel === 'answers' ? await h.answer(initial, { text }) : await h.say(text);
      expect(response.body.error?.code).toBe('SECRET_DETECTED');
      expect(h.snapshot(tables)).toBe(before);
      expect(h.llm.recorded).toEqual(calls);
      expect(h.fetcher.calls).toEqual([]);
      expect(h.exec.submissions).toEqual([]);
      for (const output of [JSON.stringify(response.body), readFileSync(h.logFile, 'utf8'), h.snapshot(tables)]) {
        expect(output).not.toContain(XPRV);
        expect(output).not.toContain(percentEncode(WRAPPED_XPRV));
      }
    } finally {
      await h.finish();
    }
  });
});
