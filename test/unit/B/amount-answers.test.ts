import { describe, expect, it } from 'vitest';
import type { QItem, Token } from '../../../src/contracts/types.js';
import { s3 } from '../../../src/pipeline/s3-amounts.js';
import { s4 } from '../../../src/pipeline/s4-type.js';
import { chip, drive, fx, scannedCtx, text } from './helpers.js';

async function missingAmount(typed = 'pay riya') {
  const ctx = await scannedCtx(typed, {
    fixture: fx(
      { name: 'amounts', match: typed, output: { amounts: [] } },
      {
        name: 'request_type',
        match: '',
        output: { request_type: 'actions', actions: ['i'], also_balance: false },
      },
    ),
  });
  expect((await drive(s3, ctx)).result).toEqual({ kind: 'continue' });
  return ctx;
}

async function typedAmount(phrase: string, number: string, token: Token | null, fiat: 'USD' | 'OTHER' | null = null) {
  const typed = `send ${phrase} to riya`;
  return scannedCtx(typed, {
    fixture: fx({
      name: 'amounts',
      match: typed,
      output: { amounts: [{ phrase, number, token, fiat, relative: null, role: 'pay' }] },
    }),
  });
}

async function documentAmount() {
  const item: QItem = { item_index: 0, address: null, ens_name: null, amount: '25', token: 'USDC' };
  return scannedCtx('pay the invoice', {
    fixture: fx({ name: 'amounts', match: 'pay the invoice', output: { amounts: [] } }),
    req: { untrusted: [item] },
  });
}

describe('currency in amount-question answers', () => {
  it.each([
    ['10 usd', '10', 'USDC', 'USD'],
    ['$10', '10', 'USDC', 'USD'],
    ['ten dollars', '10', 'USDC', 'USD'],
    ['10 USDC', '10', 'USDC', null],
    ['10usdc', '10', 'USDC', null],
    ['10 usd coin', '10', 'USDC', null],
    ['10 usdc.e', '10', 'USDC', null],
    ['0.01 ETH', '0.01', 'ETH', null],
    ['0.01eth', '0.01', 'ETH', null],
    ['ether 0.01', '0.01', 'ETH', null],
  ] as const)('Q_AMOUNT_MISSING retains the currency in %j', async (answer, amount, token, fiat) => {
    const ctx = await missingAmount();
    const result = await drive(s4, ctx, [text(answer)]);
    expect(result.questions.map((q) => q.code)).toEqual(['Q_AMOUNT_MISSING']);
    expect(result.result).toEqual({ kind: 'continue' });
    expect(ctx.req.amounts[0]).toMatchObject({
      amount,
      token,
      fiat,
      source: 'user',
      confirmed: true,
      code_verified: true,
    });
    expect([...ctx.repos.tables.db1.values()]).toMatchObject([
      { amount, token, source: 'user', origin: 'phrase', confirmed: true },
    ]);
    expect(ctx.llm.recorded.map((call) => call.name)).toEqual(['amounts', 'request_type']);
  });

  it('an explicit token in a general amount answer takes precedence over original-prompt inference', async () => {
    const ctx = await missingAmount('pay riya in usdc');
    const result = await drive(s4, ctx, [text('0.1234567 ETH')]);
    expect(result.questions.map((q) => q.code)).toEqual(['Q_AMOUNT_MISSING']);
    expect(ctx.req.amounts[0]).toMatchObject({ amount: '0.1234567', token: 'ETH', fiat: null });
  });

  it('a number without currency still asks Q_TOKEN when the original request has none', async () => {
    const ctx = await missingAmount();
    const result = await drive(s4, ctx, [text('10')]);
    expect(result.questions.map((q) => q.code)).toEqual(['Q_AMOUNT_MISSING', 'Q_TOKEN']);
    expect(ctx.repos.tables.db1.size).toBe(0);
  });

  it.each(['10 USDC ETH', '10 USD INR', '10usdt', '10usdeth', '0 USDC', '0.0000001 USDC'])(
    'does not mint an ambiguous, unsupported, zero, or too-precise answer %j',
    async (answer) => {
      const ctx = await missingAmount();
      const result = await drive(s4, ctx, [text(answer)]);
      expect(result.questions.map((q) => [q.code, q.attempt])).toEqual([
        ['Q_AMOUNT_MISSING', 1],
        ['Q_AMOUNT_MISSING', 2],
      ]);
      expect(ctx.req.amounts).toEqual([]);
      expect(ctx.repos.tables.db1.size).toBe(0);
    },
  );

  it.each(['10 rupees', '₹10', '€10', '10 pounds'])('keeps %j behind a fiat-conversion question', async (answer) => {
    const ctx = await missingAmount();
    const result = await drive(s4, ctx, [text(answer)]);
    expect(result.questions.map((q) => q.code)).toEqual(['Q_AMOUNT_MISSING', 'Q_FIAT_OTHER']);
    expect(result.questions[1]?.text).toBe(`I can't convert ${answer}. How much in USDC or ETH?`);
    expect(ctx.req.amounts).toEqual([]);
    expect(ctx.repos.tables.db1.size).toBe(0);
  });

  it.each(['₹10 ETH', '$10 ETH'])('requires an explicit crypto value for %j', async (answer) => {
    const ctx = await missingAmount();
    const result = await drive(s4, ctx, [text(answer), text('0.01 ETH')]);
    expect(result.questions.map((q) => q.code)).toEqual(['Q_AMOUNT_MISSING', 'Q_FIAT_OTHER']);
    expect(result.questions[1]?.text).toBe(`I can't convert ${answer}. How much in ETH?`);
    expect(ctx.req.amounts[0]).toMatchObject({ amount: '0.01', token: 'ETH', fiat: null, source: 'user' });
  });
});

describe('currency-specific amount questions', () => {
  it.each(['0.5 ETH', '₹0.5', '$0.5 ETH', '0.5 USDC ETH'])(
    'keeps a USDC precision question pending for conflicting answer %j',
    async (answer) => {
      const ctx = await typedAmount('0.0000001 usdc', '0.0000001', 'USDC');
      const result = await drive(s3, ctx, [text(answer)]);
      expect(result.questions.map((q) => [q.code, q.attempt])).toEqual([
        ['Q_AMOUNT_PRECISION', 1],
        ['Q_AMOUNT_PRECISION', 2],
      ]);
      expect(ctx.req.amounts).toEqual([]);
      expect(ctx.repos.tables.db1.size).toBe(0);
    },
  );

  it('applies USD-to-USDC to a USDC precision answer', async () => {
    const ctx = await typedAmount('0.0000001 usdc', '0.0000001', 'USDC');
    const result = await drive(s3, ctx, [text('0.5 USD')]);
    expect(result.questions.map((q) => q.code)).toEqual(['Q_AMOUNT_PRECISION']);
    expect(ctx.req.amounts[0]).toMatchObject({ amount: '0.5', token: 'USDC', fiat: 'USD' });
  });

  it('does not reinterpret USD as ETH in an ETH precision answer', async () => {
    const ctx = await typedAmount('0.0000000000000000001 eth', '0.0000000000000000001', 'ETH');
    const result = await drive(s3, ctx, [text('0.01 USD'), text('0.01 ETH')]);
    expect(result.questions.map((q) => [q.code, q.attempt])).toEqual([
      ['Q_AMOUNT_PRECISION', 1],
      ['Q_AMOUNT_PRECISION', 2],
    ]);
    expect(ctx.req.amounts[0]).toMatchObject({ amount: '0.01', token: 'ETH', fiat: null });
  });

  it.each(['0.01 USDC', '0.01 USD', '$0.01', '₹0.01'])(
    'does not reinterpret %j as the ETH amount requested by Q_FIAT_OTHER',
    async (answer) => {
      const ctx = await typedAmount('$10 of eth', '10', 'ETH', 'USD');
      const result = await drive(s3, ctx, [text(answer), text('0.01 ETH')]);
      expect(result.questions.map((q) => [q.code, q.attempt])).toEqual([
        ['Q_FIAT_OTHER', 1],
        ['Q_FIAT_OTHER', 2],
      ]);
      expect(ctx.req.amounts[0]).toMatchObject({ amount: '0.01', token: 'ETH', fiat: null });
    },
  );

  it('retains USD-to-USDC in an unrestricted fiat-conversion answer without asking Q_TOKEN', async () => {
    const ctx = await typedAmount('₹500', '500', null, 'OTHER');
    const result = await drive(s3, ctx, [text('10 usd')]);
    expect(result.questions.map((q) => q.code)).toEqual(['Q_FIAT_OTHER']);
    expect(ctx.req.amounts[0]).toMatchObject({ amount: '10', token: 'USDC', fiat: 'USD', code_verified: true });
  });
});

describe('document amount replacement provenance', () => {
  it('retains an explicit replacement token and marks only the validated user amount as trusted', async () => {
    const ctx = await documentAmount();
    const result = await drive(s3, ctx, [chip('type_amount'), text('0.01 ETH')]);
    expect(result.questions.map((q) => q.code)).toEqual(['Q_UNTRUSTED_AMOUNT', 'Q_AMOUNT_MISSING']);
    expect(ctx.req.amounts[0]).toMatchObject({ amount: '0.01', token: 'ETH', source: 'user', confirmed: true });
    expect([...ctx.repos.tables.db1.values()]).toMatchObject([
      { amount: '0.01', token: 'ETH', source: 'user', origin: 'document', confirmed: true },
    ]);
  });

  it.each(['0.0000001 USDC', '10 ETH USDC'])(
    'does not promote the existing untrusted document row for invalid replacement %j',
    async (answer) => {
      const ctx = await documentAmount();
      const result = await drive(s3, ctx, [chip('type_amount'), text(answer)]);
      expect(result.questions.at(-1)).toMatchObject({ code: 'Q_AMOUNT_MISSING', attempt: 2 });
      expect(ctx.req.amounts).toEqual([]);
      expect([...ctx.repos.tables.db1.values()]).toMatchObject([
        { amount: '25', token: 'USDC', source: 'untrusted', confirmed: false },
      ]);
    },
  );

  it('does not promote a fiat replacement until the user supplies a valid amount in the requested token', async () => {
    const ctx = await documentAmount();
    const result = await drive(s3, ctx, [chip('type_amount'), text('₹500')]);
    expect(result.questions.at(-1)).toMatchObject({
      code: 'Q_FIAT_OTHER',
      text: "I can't convert ₹500. How much in USDC?",
    });
    expect([...ctx.repos.tables.db1.values()]).toMatchObject([
      { amount: '25', token: 'USDC', source: 'untrusted', confirmed: false },
    ]);
    if (result.result.kind !== 'question') throw new Error('expected fiat amount question');
    expect(await s3.onAnswer!(ctx, result.result.question, text('10 usd'))).toEqual({ kind: 'continue' });
    expect(await s3.step(ctx)).toEqual({ kind: 'continue' });
    expect([...ctx.repos.tables.db1.values()]).toMatchObject([
      { amount: '10', token: 'USDC', source: 'user', confirmed: true },
    ]);
  });
});
