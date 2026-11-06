// Tests: §8.3 S2 lexical scan rules 1–10 (C-078 … C-087, C-443 §20.1 lexical), §6.2 static tables used
// (C-006 … C-014), §15 MAINNET_NOT_SUPPORTED / UNSUPPORTED_CHAIN / UNSUPPORTED_TOKEN (C-365 … C-367).
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE } from '../../../src/contracts/catalog.js';
import type { LexicalScan } from '../../../src/contracts/types.js';
import { lexicalScan } from '../../../src/lexical/scan.js';
import { s2 } from '../../../src/pipeline/s2-lexical.js';
import { makeTestContext, testConfig } from '../../fakes/context.js';

const now = DateTime.fromISO('2026-11-05T17:30:00Z', { zone: 'utc' }).setZone('Asia/Kolkata');
const chains = testConfig().chains;

function scan(text: string): LexicalScan {
  const r = lexicalScan(text, { chains, now });
  if (!r.ok) throw new Error(`unexpected ${r.code}`);
  return r.scan;
}
function err(text: string): string {
  const r = lexicalScan(text, { chains, now });
  return r.ok ? 'ok' : r.code;
}

const ADDR = '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E';

describe('lexical (§8.3, C-443)', () => {
  it('§8.3 rule 1 (C-078): clauses split at punctuation, newline, and/then/also/plus with offsets', () => {
    const t = 'send 40 usdc to a on base, and 20 usdc to b; then 5 to c\nplus 1 to d. also 2 to e! ok? fine';
    const s = scan(t);
    expect(s.clauses.map((c) => c.text)).toEqual([
      'send 40 usdc to a on base',
      '20 usdc to b',
      '5 to c',
      '1 to d',
      '2 to e',
      'ok',
      'fine',
    ]);
    for (const c of s.clauses) expect(t.slice(c.start, c.end)).toBe(c.text);
  });

  it('§8.3 rule 1: whole words only ("android" does not split), numbers and ENS names are not split', () => {
    const s = scan('pay android 1,000.5 usdc to riya.eth');
    expect(s.clauses).toHaveLength(1);
  });

  it('§8.3 rule 2 (C-079): address candidates with offsets', () => {
    const t = `send 5 usdc to ${ADDR} now`;
    const s = scan(t);
    expect(s.addresses).toHaveLength(1);
    expect(s.addresses[0]?.text).toBe(ADDR);
    expect(s.addresses[0]?.start).toBe(t.indexOf(ADDR));
  });

  it('§8.3 rule 3 (C-080): ENS candidates, normalized; not inside an email or URL', () => {
    const s = scan('send 5 usdc to Riya.eth and bob@mail.com and [link 1] and iitr.ac.in');
    expect(s.ens.map((e) => e.text)).toEqual(['Riya.eth', 'iitr.ac.in']);
    expect(s.ens[0]?.normalized).toBe('riya.eth');
  });

  it('§8.3 rule 3: a candidate failing normalize() is dropped', () => {
    const s = scan('send 5 usdc to ab--cd.eth');
    expect(s.ens.map((e) => e.text)).toEqual([]);
  });

  it('§8.3 rule 4 (C-081, C-014): group markers incl. @domain and "everyone under X"', () => {
    const a = scan('send 10 usdc to everyone on the list with @iitr.ac.in subdomain');
    expect(a.groups.map((g) => g.parent)).toEqual(['iitr.ac.in']);
    const b = scan('send 10 usdc to everyone under iitr.eth');
    expect(b.groups.map((g) => g.parent)).toEqual(['iitr.eth']);
    expect(b.ens).toEqual([]);
    const c = scan('mail bob@iitr.ac.in 5 usdc');
    expect(c.groups).toEqual([]);
  });

  it('§8.3 rule 5 (C-082): chain aliases as whole words', () => {
    const s = scan('send 5 usdc to a on base and 3 usdc to b on arb sepolia');
    expect(s.chains.map((c) => [c.word, c.chain_id])).toEqual([
      ['base', 84532],
      ['arb sepolia', 421614],
    ]);
    expect(scan('send 5 usdc to database').chains).toEqual([]);
  });

  it('§8.3 rule 5: eth/ethereum is a chain only after on/via/over/using or before chain/network/l1', () => {
    expect(scan('send 5 usdc on eth').chains.map((c) => c.chain_id)).toEqual([11155111]);
    expect(scan('send 5 usdc via ethereum').chains.map((c) => c.chain_id)).toEqual([11155111]);
    expect(scan('send 5 usdc using eth network').chains).toHaveLength(1);
    const tok = scan('send 0.1 eth to mihir');
    expect(tok.chains).toEqual([]);
    expect(tok.tokens.map((t) => t.kind)).toEqual(['ETH']);
  });

  it('§8.3 rule 6 (C-083, C-008, C-365): mainnet words → MAINNET_NOT_SUPPORTED', () => {
    expect(err('send 10 usdc on base mainnet')).toBe('MAINNET_NOT_SUPPORTED');
    expect(err('send 10 usdc on arbitrum one')).toBe('MAINNET_NOT_SUPPORTED');
    expect(err('send 10 usdc on optimism')).toBe('MAINNET_NOT_SUPPORTED');
    expect(ERROR_MESSAGE.MAINNET_NOT_SUPPORTED({})).toContain('test networks');
  });

  it('§8.3 rule 6 (C-366): unknown chain after on/via → UNSUPPORTED_CHAIN with the word', () => {
    const r = lexicalScan('send 10 usdc on polygon to mihir', { chains, now });
    expect(r).toEqual({ ok: false, code: 'UNSUPPORTED_CHAIN', params: { word: 'polygon' } });
    expect(err('send 10 usdc via solana')).toBe('UNSUPPORTED_CHAIN');
  });

  it('§8.3 rule 7 (C-084, C-006): token words: usdc aliases, eth/ether, fiat USD and fiat OTHER', () => {
    const s = scan('send 5 usdc, 1 ether, $3, 4 bucks, 2 dollars, ₹500, 7 rupees, 8 €');
    expect(s.tokens.map((t) => [t.word, t.kind])).toEqual([
      ['usdc', 'USDC'],
      ['ether', 'ETH'],
      ['$', 'FIAT_USD'],
      ['bucks', 'FIAT_USD'],
      ['dollars', 'FIAT_USD'],
      ['₹', 'FIAT_OTHER'],
      ['rupees', 'FIAT_OTHER'],
      ['€', 'FIAT_OTHER'],
    ]);
  });

  it('§8.3 rule 7 (C-007, C-367): an unsupported token word next to a number → UNSUPPORTED_TOKEN', () => {
    expect(err('send 10 dai to mihir')).toBe('UNSUPPORTED_TOKEN');
    expect(err('send ten usdt to mihir')).toBe('UNSUPPORTED_TOKEN');
    expect(err('send btc 5 to mihir')).toBe('UNSUPPORTED_TOKEN');
    expect(err('I like dai a lot, send 5 usdc')).toBe('ok');
  });

  it('§8.3 rule 8 (C-085): chrono spans with kinds and offsets in the session timezone', () => {
    const s = scan('send 10 usdc to aradhya at 5pm');
    expect(s.dates).toHaveLength(1);
    expect(s.dates[0]?.kind).toBe('time');
    expect(s.dates[0]?.time).toBe('17:00');
    const d = scan('pay mihir 10 usdc every friday starting 12 nov until 31 dec 2026');
    expect(d.dates.some((x) => x.kind === 'start' && x.date === '2026-11-12')).toBe(true);
    expect(d.dates.some((x) => x.kind === 'end' && x.date === '2026-12-31')).toBe(true);
  });

  it('§8.3 rule 9 (C-086, C-009): recurrence phrases', () => {
    const s = scan('pay mihir 10 usdc every friday, 5 usdc weekly, 3 times a week and each month');
    expect(s.recurrence.map((r) => r.word.toLowerCase())).toEqual(['every', 'weekly', '3 times a week', 'each month']);
  });

  it('§8.3 rule 9 (C-010): cancel words incl. turn off', () => {
    expect(scan('stop paying mihir').cancel.map((c) => c.word)).toEqual(['stop']);
    expect(scan('turn off the autopay for mihir').cancel).toHaveLength(1);
    expect(scan('cancel it').cancel).toHaveLength(1);
  });

  it('§8.3 rule 9 (C-011): back-reference words', () => {
    expect(scan('send 5 more').back_reference.map((b) => b.word)).toEqual(['more']);
    expect(scan('send her 5 usdc again').back_reference.map((b) => b.word)).toEqual(['her', 'again']);
  });

  it('§8.3 rule 9 (C-012): distributive words, but not inside a recurrence phrase', () => {
    expect(scan('send 10 each to aradhya and mihir').distributive.map((d) => d.word)).toEqual(['each']);
    expect(scan('pay mihir 10 usdc each week').distributive).toEqual([]);
    expect(scan('pay both of them 5 usdc').distributive.map((d) => d.word)).toEqual(['both']);
  });

  it('§8.3 rule 9 (C-013): split words', () => {
    expect(scan('split 30 between aradhya and mihir').split.map((s) => s.word)).toEqual(['split']);
    expect(scan('share between them 30 usdc').split).toHaveLength(1);
  });

  it('§8.3 rule 10 (C-087): numeric candidates with suffixes', () => {
    const s = scan('send 5k usdc and 2 lakh to b and 1,000.5 to c');
    expect(s.numeric_candidates.map((n) => n.text)).toEqual(['5k', '2 lakh', '1,000.5']);
  });

  it('§8.3 rule 10: excludes addresses, ENS names, chrono spans, ordinals and counts', () => {
    const s = scan(
      `send 10 usdc to ${ADDR} and 3 to riya1.eth at 5pm on the 1st, 3 times a week for 8 weeks, 4 payments, 2x`,
    );
    expect(s.numeric_candidates.map((n) => n.text)).toEqual(['10', '3']);
  });

  it('§8.3 S2 step: errors stop the request; otherwise the scan is stored and state SCANNED', async () => {
    const ctx = makeTestContext({ req: { typed_text: 'send 10 dai to mihir' } });
    expect(await s2.step(ctx)).toEqual({ kind: 'error', code: 'UNSUPPORTED_TOKEN' });
    const ok = makeTestContext({ req: { typed_text: 'send 10 usdc to mihir on base' } });
    expect(await s2.step(ok)).toEqual({ kind: 'continue' });
    expect(ok.req.state).toBe('SCANNED');
    expect(ok.req.scan.chains.map((c) => c.chain_id)).toEqual([84532]);
    // §18: logs carry no text
    expect(JSON.stringify(ok.log.lines)).not.toContain('mihir');
  });
});
