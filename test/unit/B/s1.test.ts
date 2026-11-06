// Tests: §8.2 S1 guard — C-057 (pasted blocks are untrusted), C-058/C-361 (attachment MIME types, ATTACHMENT_UNSUPPORTED
// naming the file), C-059 (urls[] + typed https → [link N]), C-060/C-362 (http:// and fetch failure →
// URL_FETCH_FAILED with link number), C-061…C-066 + C-442 (every secret detector, positive and negative, §20.1),
// C-067 (scan covers typed, pasted, attachment, not fetched pages), C-068/C-360 (SECRET_DETECTED: nothing in
// DB8/DB1/DB3/logs, buffers dropped), C-069 (fetch only after the scan passes), C-072 (URLs inside fetched content never
// fetched), C-073/C-363 (20,000-char cap, DOCUMENT_TOO_LARGE with item label), C-074/C-300 (one Q-LLM call per item,
// failed twice → note and no items), C-075 (QItem mapping), C-076 (DB8 rows typed/pasted only), C-077 (ENS text
// records never fetched), C-399 (the Q-LLM never sees the typed text), §18 log labels, S1 has no AnswerHandler.
import { createHash, randomBytes } from 'node:crypto';
import { base58, createBase58check } from '@scure/base';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE } from '../../../src/contracts/catalog.js';
import type { MessageInput } from '../../../src/contracts/types.js';
import { detectSecret } from '../../../src/guard/secrets.js';
import { isSecretRefusal, secretRefusal, urlHasSecret } from '../../../src/guard/urls.js';
import { s1 } from '../../../src/pipeline/s1-guard.js';
import { toQItem } from '../../../src/quarantine/qllm.js';
import { makeTestContext, type TestContext } from '../../fakes/context.js';
import type { FixtureFile } from '../../fakes/llm.js';
import { expectLabelsOk, fx, tinyPdf } from './helpers.js';

const b58check = createBase58check((d: Uint8Array) => new Uint8Array(createHash('sha256').update(d).digest()));
const EMPTY = { items: [] };
const ADDR = getAddress('0x3fa94b8e2d1c7a6f5e4d3c2b1a0f9e8d7c6bc21e'); // valid EIP-55 form
const HEX64 = 'ab'.repeat(32);
const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

function input(over: Partial<MessageInput> = {}): MessageInput {
  return { text: '', pasted_blocks: [], attachments: [], urls: [], ...over };
}
function s1ctx(inp: Partial<MessageInput>, fixture?: FixtureFile): TestContext {
  return makeTestContext({ req: { input: input(inp), typed_text: inp.text ?? '' }, fixture });
}
function emptyCalls(n: number, match = ''): FixtureFile {
  return { calls: Array.from({ length: n }, () => ({ name: 'quarantine' as const, match, output: EMPTY })) };
}

describe('S1 guard: structure', () => {
  it('S1 asks no questions and has no AnswerHandler', () => {
    expect(s1.onAnswer).toBeUndefined();
  });

  it('plain typed text: continues, one DB8 typed row, no Q-LLM call, state GUARDED', async () => {
    const ctx = s1ctx({ text: 'send 5 usdc to mihir' });
    const r = await s1.step(ctx);
    expect(r).toEqual({ kind: 'continue' });
    expect(ctx.llm.recorded).toHaveLength(0);
    expect(ctx.req.typed_text).toBe('send 5 usdc to mihir');
    expect(ctx.req.state).toBe('GUARDED');
    expect(ctx.repos.tables.db8_prompts).toHaveLength(1);
    expect(ctx.repos.tables.db8_prompts[0]).toMatchObject({ kind: 'typed', text: 'send 5 usdc to mihir' });
    expectLabelsOk(ctx);
  });
});

describe('S1 attachments (§8.2 step 1, C-058, C-361)', () => {
  it.each(['text/plain', 'text/markdown', 'text/csv', 'text/plain; charset=utf-8'])(
    'accepts %s (UTF-8 decoded)',
    async (mime) => {
      const ctx = s1ctx(
        { attachments: [{ filename: 'a.txt', mime, base64: b64('pay riya 5 usdc ünï') }] },
        emptyCalls(1, 'pay riya 5 usdc ünï'),
      );
      const r = await s1.step(ctx);
      expect(r.kind).toBe('continue');
      expect(ctx.llm.recorded).toHaveLength(1);
      expect(ctx.llm.recorded[0]?.user).toContain('ünï');
    },
  );

  it('accepts application/pdf (pdf-parse text goes to the Q-LLM)', async () => {
    const pdf = Buffer.from(tinyPdf('Pay Riya 5 USDC')).toString('base64');
    const ctx = s1ctx(
      { attachments: [{ filename: 'inv.pdf', mime: 'application/pdf', base64: pdf }] },
      emptyCalls(1, 'Riya'),
    );
    const r = await s1.step(ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.llm.recorded[0]?.user).toContain('Pay Riya 5 USDC');
  });

  it('image/png → ATTACHMENT_UNSUPPORTED naming the file; whole request stops, nothing stored (C-361)', async () => {
    const ctx = s1ctx({
      text: 'pay riya 5 usdc',
      attachments: [
        { filename: 'ok.txt', mime: 'text/plain', base64: b64('x') },
        { filename: 'scan.png', mime: 'image/png', base64: b64('x') },
      ],
    });
    const r = await s1.step(ctx);
    expect(r).toMatchObject({ kind: 'error', code: 'ATTACHMENT_UNSUPPORTED', params: { filename: 'scan.png' } });
    if (r.kind === 'error') {
      expect(ERROR_MESSAGE.ATTACHMENT_UNSUPPORTED(r.params ?? {})).toBe(
        "I can only read text and PDF files. scan.png wasn't read, so nothing was done.",
      );
    }
    expect(ctx.repos.tables.db8_prompts).toHaveLength(0);
    expect(ctx.llm.recorded).toHaveLength(0);
  });
});

describe('S1 URLs (§8.2 steps 1 and 3, C-059, C-060, C-362, C-069, C-072)', () => {
  it('typed https URL is replaced by [link N]; urls[] entries are links 1..u, typed ones continue (SQB-02)', async () => {
    const ctx = s1ctx(
      { text: 'pay what is in https://x.example/a.html, thanks', urls: ['https://y.example/b'] },
      emptyCalls(2),
    );
    ctx.fetcher.pages.set('https://y.example/b', { ok: true, text: 'page B' });
    ctx.fetcher.pages.set('https://x.example/a.html', { ok: true, text: 'page A' });
    const r = await s1.step(ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.req.typed_text).toBe('pay what is in [link 2], thanks');
    expect(ctx.fetcher.calls).toEqual(['https://y.example/b', 'https://x.example/a.html']);
    expect(ctx.repos.tables.db8_prompts).toHaveLength(1);
    expect(ctx.repos.tables.db8_prompts[0]).toMatchObject({ kind: 'typed', text: 'pay what is in [link 2], thanks' });
  });

  it('http:// link in urls[] → URL_FETCH_FAILED with its link number, no fetch', async () => {
    const ctx = s1ctx({ urls: ['https://ok.example/', 'http://plain.example/'] });
    const r = await s1.step(ctx);
    expect(r).toMatchObject({ kind: 'error', code: 'URL_FETCH_FAILED', params: { n: '2' } });
    if (r.kind === 'error')
      expect(ERROR_MESSAGE.URL_FETCH_FAILED(r.params ?? {})).toBe("I couldn't open link 2, so nothing was done.");
    expect(ctx.fetcher.calls).toEqual([]);
  });

  it('http:// link typed in the text → URL_FETCH_FAILED with its link number', async () => {
    const ctx = s1ctx({ text: 'see http://plain.example/x now' });
    const r = await s1.step(ctx);
    expect(r).toMatchObject({ kind: 'error', code: 'URL_FETCH_FAILED', params: { n: '1' } });
    expect(ctx.fetcher.calls).toEqual([]);
    expect(ctx.repos.tables.db8_prompts).toHaveLength(0);
  });

  it('a fetch failure → URL_FETCH_FAILED with the failing link number (C-362, C-072)', async () => {
    const ctx = s1ctx({ urls: ['https://a.example/', 'https://b.example/'] }, emptyCalls(1));
    ctx.fetcher.pages.set('https://a.example/', { ok: true, text: 'fine' });
    const r = await s1.step(ctx);
    expect(r).toMatchObject({ kind: 'error', code: 'URL_FETCH_FAILED', params: { n: '2' } });
    expect(ctx.repos.tables.db8_prompts).toHaveLength(0);
  });

  it('URLs inside a fetched page are never fetched (C-072)', async () => {
    const ctx = s1ctx({ urls: ['https://a.example/'] }, emptyCalls(1));
    ctx.fetcher.pages.set('https://a.example/', { ok: true, text: 'see https://evil.example/ and http://x.example' });
    await s1.step(ctx);
    expect(ctx.fetcher.calls).toEqual(['https://a.example/']);
  });

  it('C-077: ENS text records are never fetched (no ENS lookup in S1)', async () => {
    const ctx = s1ctx({ text: 'pay riya.eth 5 usdc' });
    await s1.step(ctx);
    expect(ctx.ens.calls).toEqual([]);
    expect(ctx.fetcher.calls).toEqual([]);
  });
});

describe('S1 secret scan (§8.2 step 2, C-061…C-068, C-360, C-442)', () => {
  const xprvKey = (prefix: number[]): string => {
    const payload = new Uint8Array(78);
    payload.set(prefix, 0);
    payload.set(randomBytes(74), 4);
    return b58check.encode(payload);
  };
  const wifKey = (first: number): string => {
    const p = new Uint8Array(34);
    p[0] = first;
    p.set(randomBytes(32), 1);
    p[33] = 1;
    return b58check.encode(p);
  };
  const solana = (): string => {
    let s = base58.encode(randomBytes(64));
    while (s.length < 86) s = base58.encode(randomBytes(64));
    return s;
  };

  it('§20.1 every detector positive (xprv/yprv/zprv/tprv, WIF 5/K/L, solana, seed, keystore, raw hex with and without 0x)', () => {
    const positives: string[] = [
      HEX64,
      `0x${HEX64}`,
      xprvKey([0x04, 0x88, 0xad, 0xe4]),
      xprvKey([0x04, 0x9d, 0x78, 0x78]),
      wifKey(0x80),
      solana(),
      SEED,
      JSON.stringify({ crypto: { ciphertext: 'aa', kdf: 'scrypt' } }),
    ];
    for (const p of positives) expect(detectSecret(`please ${p} thanks`), p.slice(0, 12)).not.toBeNull();
  });

  it('§20.1 negatives: 63/65 hex, address, 11 BIP-39 words, 85-char / 32-byte base58, ordinary prompts', () => {
    expect(detectSecret('a'.repeat(63))).toBeNull();
    expect(detectSecret('a'.repeat(65))).toBeNull();
    expect(detectSecret(`send 5 usdc to ${ADDR}`)).toBeNull();
    expect(detectSecret(`${SEED.split(' ').slice(0, 11).join(' ')} and then pay`)).toBeNull();
    expect(detectSecret(base58.encode(randomBytes(32)))).toBeNull();
    expect(detectSecret('send 5 usdc to mihir.eth and 1 eth to aradhya on base')).toBeNull();
    expect(detectSecret(JSON.stringify({ crypto: { ciphertext: 'aa' } }))).toBeNull();
  });

  it('seed phrase of 12 words split by other words twice is not a run of 12', () => {
    const w = SEED.split(' ');
    expect(detectSecret(`${w.slice(0, 6).join(' ')} xyzzy ${w.slice(6).join(' ')}`)).toBeNull();
  });

  const cases: Array<[string, (secret: string) => Partial<MessageInput>]> = [
    ['typed text', (s) => ({ text: `send 5 usdc to mihir ${s}` })],
    ['a pasted block', (s) => ({ text: 'pay mihir', pasted_blocks: [`invoice\n${s}`] })],
    [
      'attachment text',
      (s) => ({ text: 'pay mihir', attachments: [{ filename: 'n.txt', mime: 'text/plain', base64: b64(s) }] }),
    ],
  ];
  for (const [where, mk] of cases) {
    it(`secret in ${where} → SECRET_DETECTED; nothing in DB8/DB1/DB3/logs; buffers dropped; fetch not attempted`, async () => {
      const secrets = [HEX64, SEED];
      for (const secret of secrets) {
        const inp = mk(secret);
        const ctx = s1ctx({ ...inp, urls: ['https://a.example/'] }, emptyCalls(2));
        ctx.fetcher.pages.set('https://a.example/', { ok: true, text: 'page' });
        const r = await s1.step(ctx);
        expect(r.kind).toBe('error');
        if (r.kind === 'error') {
          expect(r.code).toBe('SECRET_DETECTED');
          expect(ERROR_MESSAGE.SECRET_DETECTED(r.params ?? {})).toMatch(
            /^This looks like a private key or recovery phrase\./,
          );
        }
        expect(ctx.repos.tables.db8_prompts).toHaveLength(0);
        expect(ctx.repos.tables.db8_history).toHaveLength(0);
        expect(ctx.repos.tables.db1.size).toBe(0);
        expect(ctx.repos.tables.db3.size).toBe(0);
        expect(JSON.stringify(ctx.log.lines)).not.toContain(secret.slice(0, 20));
        expect(JSON.stringify(ctx.repos.tables)).not.toContain(secret.slice(0, 20));
        expect(ctx.fetcher.calls).toEqual([]); // §8.2 step 3: fetch only after the scan passes
        expect(ctx.llm.recorded).toHaveLength(0);
        expect(ctx.req.input).toBeUndefined();
        expect(ctx.req.typed_text).toBe('');
        expect(ctx.req.untrusted).toEqual([]);
        expectLabelsOk(ctx);
      }
    });
  }

  it('C-067: a secret inside a FETCHED page does not block (it goes to the Q-LLM only)', async () => {
    const ctx = s1ctx({ urls: ['https://a.example/'] }, emptyCalls(1, HEX64));
    ctx.fetcher.pages.set('https://a.example/', { ok: true, text: `leaked ${HEX64}` });
    const r = await s1.step(ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.llm.recorded).toHaveLength(1);
  });
});

describe('S1 secret scan of links (SQ-O-06)', () => {
  const SEED_PCT = SEED.replace(/ /g, '%20');
  const SEED_PLUS = SEED.replace(/ /g, '+');
  const KEY_PCT = [...HEX64].map((ch) => `%${ch.charCodeAt(0).toString(16)}`).join('');

  it.each(['&discount=50%', '&label=%FF', '%FF', '%'])(
    'B15: malformed URL encoding %s cannot hide an encoded key',
    async (suffix) => {
      const url = `https://a.example/?key=${KEY_PCT}${suffix}`;
      expect(urlHasSecret(url)).toBe(true);
      for (const channel of ['typed', 'urls'] as const) {
        const ctx = s1ctx(channel === 'typed' ? { text: `read ${url}` } : { text: 'read invoice', urls: [url] });
        expect(await s1.step(ctx)).toEqual({ kind: 'error', code: 'SECRET_DETECTED' });
        expect(ctx.fetcher.calls).toEqual([]);
        expect(ctx.llm.recorded).toEqual([]);
        expect(ctx.repos.tables.db8_prompts).toHaveLength(0);
        expect(ctx.repos.tables.db1.size).toBe(0);
        expect(ctx.repos.tables.db3.size).toBe(0);
        expect(JSON.stringify(ctx.log.lines)).not.toContain(HEX64);
      }
    },
  );

  it('B15: malformed path bytes do not suppress query, path or seed decoding', () => {
    expect(urlHasSecret(`https://a.example/%FF?key=${KEY_PCT}`)).toBe(true);
    expect(urlHasSecret(`https://a.example/%FF${KEY_PCT}?discount=50%`)).toBe(true);
    expect(urlHasSecret(`https://a.example/?seed=${SEED_PCT}&label=%FF`)).toBe(true);
    expect(urlHasSecret('https://a.example/%FF?discount=50%&name=Jos%C3%A9')).toBe(false);
  });

  it('SQ-O-06 urlHasSecret: as written and percent-decoded, "+" as space; clean URLs pass', () => {
    expect(urlHasSecret(`https://a.example/?k=${HEX64}`)).toBe(true);
    expect(urlHasSecret(`https://a.example/?k=0x${HEX64}`)).toBe(true);
    expect(urlHasSecret(`https://a.example/?m=${SEED_PCT}`)).toBe(true);
    expect(urlHasSecret(`https://a.example/?m=${SEED_PLUS}`)).toBe(true);
    expect(urlHasSecret(`https://a.example/#${HEX64}`)).toBe(true);
    expect(urlHasSecret('https://a.example/path/%E0%A4%A?x=1')).toBe(false); // malformed escape does not throw
    expect(urlHasSecret('https://a.example/page?id=42&q=hello+world')).toBe(false);
    expect(urlHasSecret(`https://a.example/tx/0x${'ab'.repeat(20)}`)).toBe(false);
  });

  it('SQ-O-06 secretRefusal() is a failed FetchResult that isSecretRefusal tells apart from a plain failure', () => {
    expect(secretRefusal().ok).toBe(false);
    expect(isSecretRefusal(secretRefusal())).toBe(true);
    expect(isSecretRefusal({ ok: false })).toBe(false);
    expect(isSecretRefusal({ ok: true, text: 'x' })).toBe(false);
  });

  const bad: Array<[string, string, string]> = [
    ['raw hex key in a query string', `https://a.example/?k=${HEX64}`, HEX64],
    ['percent-encoded seed phrase', `https://a.example/?m=${SEED_PCT}`, 'abandon'],
    ['plus-separated seed phrase', `https://a.example/?m=${SEED_PLUS}`, 'abandon'],
  ];
  it.each(bad)('SQ-O-06 %s in urls[] -> SECRET_DETECTED, nothing fetched or stored', async (_n, url, needle) => {
    const ctx = s1ctx({ text: 'read this', urls: [url, 'https://clean.example/'] }, emptyCalls(2));
    ctx.fetcher.pages.set('https://clean.example/', { ok: true, text: 'page' });
    const r = await s1.step(ctx);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.code).toBe('SECRET_DETECTED');
    expect(ctx.fetcher.calls).toEqual([]);
    expect(ctx.llm.recorded).toHaveLength(0);
    expect(ctx.repos.tables.db8_prompts).toHaveLength(0);
    expect(ctx.repos.tables.db8_history).toHaveLength(0);
    expect(ctx.repos.tables.db1.size).toBe(0);
    expect(ctx.repos.tables.db3.size).toBe(0);
    expect(JSON.stringify(ctx.log.lines)).not.toContain(needle);
    expect(JSON.stringify(ctx.repos.tables)).not.toContain(needle);
    expect(ctx.req.input).toBeUndefined();
    expect(ctx.req.untrusted).toEqual([]);
  });

  it('SQ-O-06 a typed URL with a key is blocked (already was) and nothing is fetched', async () => {
    const ctx = s1ctx({ text: `see https://a.example/?k=${HEX64} please` }, emptyCalls(1));
    const r = await s1.step(ctx);
    expect(r.kind === 'error' && r.code).toBe('SECRET_DETECTED');
    expect(ctx.fetcher.calls).toEqual([]);
  });

  it('SQ-O-06 a clean URL is still fetched', async () => {
    const ctx = s1ctx({ urls: ['https://a.example/page?id=42&q=hello+world'] }, emptyCalls(1));
    ctx.fetcher.pages.set('https://a.example/page?id=42&q=hello+world', { ok: true, text: 'page' });
    const r = await s1.step(ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.fetcher.calls).toEqual(['https://a.example/page?id=42&q=hello+world']);
  });

  it('SQ-O-06 a fetcher secretRefusal() (key in a redirect target) -> SECRET_DETECTED, buffers dropped, nothing stored', async () => {
    const ctx = s1ctx({ text: 'read this', urls: ['https://a.example/'] }, emptyCalls(1));
    ctx.fetcher.pages.set('https://a.example/', secretRefusal());
    const r = await s1.step(ctx);
    expect(r.kind === 'error' && r.code).toBe('SECRET_DETECTED');
    expect(ctx.llm.recorded).toHaveLength(0);
    expect(ctx.repos.tables.db8_prompts).toHaveLength(0);
    expect(ctx.repos.tables.db8_history).toHaveLength(0);
    expect(ctx.req.input).toBeUndefined();
    expect(ctx.req.typed_text).toBe('');
    expect(ctx.req.untrusted).toEqual([]);
    expect(JSON.stringify(ctx.log.lines)).not.toContain('a.example');
  });

  it('SQ-O-06 a plain fetch failure is still URL_FETCH_FAILED, not SECRET_DETECTED', async () => {
    const ctx = s1ctx({ urls: ['https://a.example/'] }, emptyCalls(1));
    const r = await s1.step(ctx);
    expect(r.kind === 'error' && r.code).toBe('URL_FETCH_FAILED');
  });
});

describe('S1 size cap (§8.2 step 4, C-073, C-363)', () => {
  it('20,000 characters are accepted; 20,001 → DOCUMENT_TOO_LARGE with the item label', async () => {
    const ok = s1ctx({ pasted_blocks: ['x'.repeat(20000)] }, emptyCalls(1));
    expect((await s1.step(ok)).kind).toBe('continue');

    const big = s1ctx({ pasted_blocks: ['x'.repeat(20001)] });
    const r = await s1.step(big);
    expect(r).toMatchObject({ kind: 'error', code: 'DOCUMENT_TOO_LARGE', params: { item: 'pasted text 1' } });
    if (r.kind === 'error')
      expect(ERROR_MESSAGE.DOCUMENT_TOO_LARGE(r.params ?? {})).toBe('pasted text 1 is too long for me to read safely.');
    expect(big.repos.tables.db8_prompts).toHaveLength(0);
  });

  it('counts characters, not UTF-16 units or bytes; names attachments by filename and pages by link N', async () => {
    const emoji = s1ctx({ pasted_blocks: ['😀'.repeat(20000)] }, emptyCalls(1));
    expect((await s1.step(emoji)).kind).toBe('continue');

    const att = s1ctx({ attachments: [{ filename: 'big.csv', mime: 'text/csv', base64: b64('y'.repeat(20001)) }] });
    expect(await s1.step(att)).toMatchObject({ code: 'DOCUMENT_TOO_LARGE', params: { item: 'big.csv' } });

    const page = s1ctx({ urls: ['https://a.example/'] });
    page.fetcher.pages.set('https://a.example/', { ok: true, text: 'z'.repeat(20001) });
    expect(await s1.step(page)).toMatchObject({ code: 'DOCUMENT_TOO_LARGE', params: { item: 'link 1' } });
  });
});

describe('S1 Q-LLM extraction (§8.2 step 5, C-074, C-075, C-300, C-399)', () => {
  it('one call per content item; the typed text never reaches the Q-LLM', async () => {
    const ctx = s1ctx(
      {
        text: 'TYPED-ONLY-WORDS pay the invoice',
        pasted_blocks: ['block one', 'block two'],
        attachments: [{ filename: 'a.md', mime: 'text/markdown', base64: b64('attachment text') }],
        urls: ['https://a.example/'],
      },
      fx(
        {
          name: 'quarantine',
          match: 'block one',
          output: { items: [{ address: ADDR, ens_name: null, amount: '5', token: 'USDC' }] },
        },
        { name: 'quarantine', match: 'block two', output: EMPTY },
        {
          name: 'quarantine',
          match: 'attachment text',
          output: { items: [{ address: null, ens_name: 'riya.eth', amount: null, token: null }] },
        },
        { name: 'quarantine', match: 'page text', output: EMPTY },
      ),
    );
    ctx.fetcher.pages.set('https://a.example/', { ok: true, text: 'page text' });
    const r = await s1.step(ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.llm.recorded.map((c) => c.name)).toEqual(['quarantine', 'quarantine', 'quarantine', 'quarantine']);
    for (const c of ctx.llm.recorded) {
      expect(c.user).not.toContain('TYPED-ONLY-WORDS');
      expect(c.system).not.toContain('TYPED-ONLY-WORDS');
    }
    expect(ctx.req.untrusted).toEqual([
      { item_index: 0, address: ADDR, ens_name: null, amount: '5', token: 'USDC' },
      { item_index: 2, address: null, ens_name: 'riya.eth', amount: null, token: null },
    ]);
  });

  it('invalid output twice → note "Couldn\'t read anything usable from <item>." and that item yields nothing; others still read', async () => {
    const ctx = s1ctx(
      { pasted_blocks: ['bad block', 'good block'] },
      fx(
        { name: 'quarantine', match: 'bad block', output: { nope: 1 } },
        { name: 'quarantine', match: 'bad block', output: { nope: 2 }, attempt: 2 },
        {
          name: 'quarantine',
          match: 'good block',
          output: { items: [{ address: null, ens_name: null, amount: '7', token: null }] },
        },
      ),
    );
    const r = await s1.step(ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.req.notes).toEqual(["Couldn't read anything usable from pasted text 1."]);
    expect(ctx.req.untrusted).toEqual([{ item_index: 1, address: null, ens_name: null, amount: '7', token: null }]);
  });

  it('QItem mapping: bad address / bad amount → null; all-null entries dropped; ens kept; lowercase address checksummed', () => {
    const e = (
      address: string | null,
      ens_name: string | null,
      amount: string | null,
      token: 'USDC' | 'ETH' | null,
    ) => ({ address, ens_name, amount, token });
    expect(toQItem(3, e('0x123', null, '5', null))).toEqual({
      item_index: 3,
      address: null,
      ens_name: null,
      amount: '5',
      token: null,
    });
    expect(toQItem(0, e(null, null, '1,000', null))).toBeNull();
    expect(toQItem(0, e(null, null, '-5', null))).toBeNull();
    expect(toQItem(0, e(null, null, '5.', null))).toBeNull();
    expect(toQItem(0, e('nonsense', '', null, null))).toBeNull();
    expect(toQItem(0, e(null, 'riya.eth', null, null))?.ens_name).toBe('riya.eth');
    expect(toQItem(0, e(ADDR.toLowerCase(), null, '0.5', 'ETH'))).toEqual({
      item_index: 0,
      address: ADDR,
      ens_name: null,
      amount: '0.5',
      token: 'ETH',
    });
    // mixed-case with a broken EIP-55 checksum
    const bad = ADDR.slice(0, -1) + (ADDR.endsWith('E') ? 'e' : 'E');
    expect(toQItem(0, e(bad, null, '1', null))?.address).toBeNull();
    expect(toQItem(0, e(ADDR, null, '1', null))?.address).toBe(ADDR);
  });
});

describe('S1 persistence (§8.2 step 6, C-076) and logs (§18)', () => {
  it('stores typed text (after URL replacement) and each pasted block; attachments and pages are not stored', async () => {
    const ctx = s1ctx(
      {
        text: 'pay per https://a.example/ please',
        pasted_blocks: ['PASTED-ONE', 'PASTED-TWO'],
        attachments: [{ filename: 'a.txt', mime: 'text/plain', base64: b64('ATTACHMENT-BODY') }],
      },
      emptyCalls(4),
    );
    ctx.fetcher.pages.set('https://a.example/', { ok: true, text: 'PAGE-BODY' });
    expect((await s1.step(ctx)).kind).toBe('continue');
    const rows = ctx.repos.tables.db8_prompts;
    expect(rows.map((r) => [r.kind, r.text])).toEqual([
      ['typed', 'pay per [link 1] please'],
      ['pasted', 'PASTED-ONE'],
      ['pasted', 'PASTED-TWO'],
    ]);
    for (const r of rows) expect([r.session_id, r.request_id]).toEqual(['ses_000000000001', 'req_000000000001']);
    const json = JSON.stringify(rows);
    expect(json).not.toContain('ATTACHMENT-BODY');
    expect(json).not.toContain('PAGE-BODY');
    // logs carry only allowlisted counters, never content
    const logs = JSON.stringify(ctx.log.lines);
    for (const s of ['PASTED-ONE', 'ATTACHMENT-BODY', 'PAGE-BODY', 'a.example']) expect(logs).not.toContain(s);
    expectLabelsOk(ctx);
  });
});
