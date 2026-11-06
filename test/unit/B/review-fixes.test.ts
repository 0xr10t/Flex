// Tests for the Lane Reviewer fixes (commit 9e7a778): SQB-24 (uncovered number overlapping a returned phrase,
// C-095/C-309), SQB-26 (findUnused word-edge rule, C-089), extractUrls trailing punctuation / closing brackets
// (C-059, §8.2 step 1).
import { describe, expect, it } from 'vitest';
import { extractUrls } from '../../../src/guard/urls.js';
import { findUnused } from '../../../src/lexical/text.js';
import { s3 } from '../../../src/pipeline/s3-amounts.js';
import { chip, drive, expectLabelsOk, fx, scannedCtx } from './helpers.js';

const amounts = (typed: string, phrase: string, number: string) =>
  fx({
    name: 'amounts',
    match: typed,
    output: { amounts: [{ phrase, number, relative: null, token: 'USDC', fiat: null, role: 'pay' }] },
  });

describe('SQB-24 uncovered number overlapping a phrase (S3)', () => {
  const typed = 'send 5k usdc to a';

  async function setup() {
    const ctx = await scannedCtx(typed, { fixture: amounts(typed, '5', '5') });
    return ctx;
  }

  it('precondition: S2 yields a numeric candidate that overlaps but is not inside the phrase "5"', async () => {
    const ctx = await setup();
    const c = ctx.req.scan.numeric_candidates.find((x) => x.text === '5k');
    expect(c).toBeDefined();
  });

  it('asks Q_AMOUNT_UNCOVERED for 5k; Yes → UNSUPPORTED_REQUEST with rule_id S3_UNCOVERED_OVERLAPS_PHRASE', async () => {
    const ctx = await setup();
    const r = await drive(s3, ctx, [chip('yes')]);
    expect(r.questions[0]).toMatchObject({ code: 'Q_AMOUNT_UNCOVERED', text: 'Should 5k be paid?' });
    expect(r.result).toEqual({ kind: 'error', code: 'UNSUPPORTED_REQUEST' });
    expect(ctx.log.lines.find((l) => l.event === 'unsupported_state')).toMatchObject({
      rule_id: 'S3_UNCOVERED_OVERLAPS_PHRASE',
      step: 's3',
    });
    expectLabelsOk(ctx);
  });

  it('No → continues with only the "5" amount', async () => {
    const ctx = await setup();
    const r = await drive(s3, ctx, [chip('no')]);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(ctx.req.amounts).toHaveLength(1);
    expect(ctx.req.amounts[0]).toMatchObject({ phrase: '5', amount: '5' });
    expect(ctx.repos.tables.db1.size).toBe(1);
  });
});

describe('SQB-26 findUnused word edges', () => {
  it('"5" is not found inside "50"; "riya" not inside "riyaz"', () => {
    expect(findUnused('send 50 usdc', '5', [], true)).toBeNull();
    expect(findUnused('pay riyaz now', 'riya', [], true)).toBeNull();
    expect(findUnused('pay 5 now', '5', [], true)).toEqual({ start: 4, end: 5 });
  });

  it('"50" is found in "50usdc" (digit next to letter is allowed)', () => {
    expect(findUnused('send 50usdc to a', '50', [], true)).toEqual({ start: 5, end: 7 });
  });

  it('"riya.eth" is found in "@riya.eth"', () => {
    expect(findUnused('pay @riya.eth now', 'riya.eth', [], true)).toEqual({ start: 5, end: 13 });
  });

  it('skips a glued occurrence and returns a later clean one; without wholeWord substrings match', () => {
    expect(findUnused('riyaz and riya', 'riya', [], true)).toEqual({ start: 10, end: 14 });
    expect(findUnused('pay riyaz', 'riya', [], false)).toEqual({ start: 4, end: 8 });
  });

  it('S3: phrase "50" in "send 50usdc to a" is accepted', async () => {
    const typed = 'send 50usdc to a';
    const ctx = await scannedCtx(typed, { fixture: amounts(typed, '50', '50') });
    const r = await drive(s3, ctx, [chip('no')]);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(ctx.req.amounts[0]).toMatchObject({ phrase: '50', amount: '50', token: 'USDC' });
    expect(ctx.req.masked_text_s3).toBe(`send ${ctx.req.amounts[0]?.placeholder}usdc to a`);
  });
});

describe('extractUrls trailing punctuation and brackets', () => {
  it.each(['.', ',', ';', ':', '!', '?'])('strips a trailing %s and keeps it in the text', (p) => {
    const r = extractUrls(`see https://a.example/x${p} ok`, []);
    expect(r.links.map((l) => l.url)).toEqual(['https://a.example/x']);
    expect(r.typed_text).toBe(`see [link 1]${p} ok`);
  });

  it('strips several trailing punctuation marks', () => {
    const r = extractUrls('go https://a.example/x?!.', []);
    expect(r.links[0]?.url).toBe('https://a.example/x');
    expect(r.typed_text).toBe('go [link 1]?!.');
  });

  it('keeps ")" that closes a "(" inside the URL, then strips the sentence period', () => {
    const r = extractUrls('see https://en.wikipedia.org/wiki/Foo_(bar).', []);
    expect(r.links[0]?.url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(r.typed_text).toBe('see [link 1].');
  });

  it('strips an unmatched ")": "(https://a.example/x)"', () => {
    const r = extractUrls('(https://a.example/x)', []);
    expect(r.links[0]?.url).toBe('https://a.example/x');
    expect(r.typed_text).toBe('([link 1])');
  });

  it('balanced then unmatched: Foo_(bar)) keeps one ")"', () => {
    const r = extractUrls('(see https://a.example/Foo_(bar))', []);
    expect(r.links[0]?.url).toBe('https://a.example/Foo_(bar)');
    expect(r.typed_text).toBe('(see [link 1])');
  });

  it('brackets and braces behave the same way', () => {
    expect(extractUrls('[https://a.example/x]', []).links[0]?.url).toBe('https://a.example/x');
    expect(extractUrls('https://a.example/a[1]', []).links[0]?.url).toBe('https://a.example/a[1]');
  });

  it('link numbers continue after urls[] entries', () => {
    const r = extractUrls('and https://b.example/y.', ['https://a.example/']);
    expect(r.links.map((l) => [l.n, l.url])).toEqual([
      [1, 'https://a.example/'],
      [2, 'https://b.example/y'],
    ]);
    expect(r.typed_text).toBe('and [link 2].');
  });
});
