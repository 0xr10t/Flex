// Tests: §8.4 step 3 code parser (C-444 §20.1 amounts/parser), §13.4 number answers (C-333), I-42, I-43.
import { describe, expect, it } from 'vitest';
import { parseAmountText } from '../../../src/amounts/parse.js';

const ok = (value: string) => ({ ok: true, value });

describe('amounts/parser (§8.4 step 3, C-444)', () => {
  it('§8.4 step 3 digits: plain integers and decimals', () => {
    expect(parseAmountText('50', 'USDC')).toEqual(ok('50'));
    expect(parseAmountText('0.5', 'ETH')).toEqual(ok('0.5'));
    expect(parseAmountText('10.20', 'USDC')).toEqual(ok('10.2'));
    expect(parseAmountText('007', null)).toEqual(ok('7'));
  });

  it('§8.4 step 3 digits: commas between digit groups', () => {
    expect(parseAmountText('1,000', null)).toEqual(ok('1000'));
    expect(parseAmountText('1,234,567.5', null)).toEqual(ok('1234567.5'));
    expect(parseAmountText('10,00,000', null)).toEqual(ok('1000000'));
    expect(parseAmountText('1,0', null)).toEqual({ ok: false, reason: 'unparseable' });
  });

  it('§8.4 step 3 suffixes: k ×1,000, m ×1,000,000, lakh ×100,000, crore ×10,000,000', () => {
    expect(parseAmountText('5k', null)).toEqual(ok('5000'));
    expect(parseAmountText('1.2m', null)).toEqual(ok('1200000'));
    expect(parseAmountText('2.5 lakh', null)).toEqual(ok('250000'));
    expect(parseAmountText('3 lakhs', null)).toEqual(ok('300000'));
    expect(parseAmountText('2 crore', null)).toEqual(ok('20000000'));
    expect(parseAmountText('1.5 crores', null)).toEqual(ok('15000000'));
  });

  it('§8.4 step 3 English number words zero … nine hundred ninety-nine million', () => {
    expect(parseAmountText('fifty', null)).toEqual(ok('50'));
    expect(parseAmountText('two hundred and five', null)).toEqual(ok('205'));
    expect(parseAmountText('twenty-five thousand', null)).toEqual(ok('25000'));
    expect(parseAmountText('nine hundred ninety-nine million', null)).toEqual(ok('999000000'));
    expect(parseAmountText('one million two hundred thousand', null)).toEqual(ok('1200000'));
    expect(parseAmountText('five lakh', null)).toEqual(ok('500000'));
    expect(parseAmountText('two crore', null)).toEqual(ok('20000000'));
    expect(parseAmountText('fifty fifty', null)).toEqual({ ok: false, reason: 'unparseable' });
    expect(parseAmountText('a billion', null)).toEqual({ ok: false, reason: 'unparseable' });
  });

  it('§8.4 step 3 currency words around the number carry no value ("50 USDc", "fifty bucks", "$5")', () => {
    expect(parseAmountText('50 USDc', 'USDC')).toEqual(ok('50'));
    expect(parseAmountText('fifty bucks', null)).toEqual(ok('50'));
    expect(parseAmountText('$5', null)).toEqual(ok('5'));
    expect(parseAmountText('0.01 eth', 'ETH')).toEqual(ok('0.01'));
  });

  it('§8.4 step 3 precision per token (USDC 6, ETH 18) → reason precision (I-43)', () => {
    expect(parseAmountText('0.1234567', 'USDC')).toEqual({ ok: false, reason: 'precision' });
    expect(parseAmountText('0.123456', 'USDC')).toEqual(ok('0.123456'));
    expect(parseAmountText('0.1234567', 'ETH')).toEqual(ok('0.1234567'));
    expect(parseAmountText('0.' + '1'.repeat(19), 'ETH')).toEqual({ ok: false, reason: 'precision' });
    expect(parseAmountText('0.1234567', null)).toEqual(ok('0.1234567'));
  });

  it('§8.4 step 3 zero → reason zero', () => {
    expect(parseAmountText('0', 'USDC')).toEqual({ ok: false, reason: 'zero' });
    expect(parseAmountText('0.000', null)).toEqual({ ok: false, reason: 'zero' });
    expect(parseAmountText('zero', null)).toEqual({ ok: false, reason: 'zero' });
  });

  it('C-333 §13.4: number answers are parsed by code (unparseable text rejected, no model)', () => {
    expect(parseAmountText('about ten-ish', 'USDC')).toEqual({ ok: false, reason: 'unparseable' });
    expect(parseAmountText('', 'USDC')).toEqual({ ok: false, reason: 'unparseable' });
    expect(parseAmountText('-5', 'USDC')).toEqual({ ok: false, reason: 'unparseable' });
  });
});
