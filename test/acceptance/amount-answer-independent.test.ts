// Independent grading of currency retention, summary provenance, and document replacement validation.
// HTTP cases use the real session manager and SQLCipher with fixture-only external services.
import { describe, expect, it } from 'vitest';
import type { Token } from '../../src/contracts/types.js';
import { buildSummary } from '../../src/messages/summary.js';
import { s3 } from '../../src/pipeline/s3-amounts.js';
import { s4 } from '../../src/pipeline/s4-type.js';
import type { FixtureFile } from '../fakes/llm.js';
import { chip, drive, fx, scannedCtx, text } from '../unit/B/helpers.js';
import { addMihir, BASE, planI } from '../unit/D/helpers.js';
import { Harness, loadFixture, MIHIR } from './harness.js';

function missingFixture(): FixtureFile {
  const calls = structuredClone(loadFixture('A-55').calls);
  calls[0] = { name: 'amounts', match: 'send to mihir', output: { amounts: [] } };
  return { calls };
}

describe('amount answer currencies through HTTP', () => {
  it.each([
    { number: null, relative: null, token: null, fiat: null },
    { number: '10', relative: null, token: 'ETH', fiat: 'OTHER' },
    { number: null, relative: 'all', token: 'USDC', fiat: null },
  ] as const)(
    'a malformed model amount spanning pay mihir ($number/$relative) cannot erase the action or recipient after an amount answer',
    async (extraction) => {
      const calls = structuredClone(loadFixture('A-55').calls);
      calls[0] = {
        name: 'amounts',
        match: 'pay mihir',
        output: {
          amounts: [{ phrase: 'pay mihir', ...extraction, role: 'pay' }],
        },
      };
      calls[1]!.match = 'pay mihir';
      calls[2]!.match = 'pay mihir';
      const h = new Harness('amount-answer-broad-model-phrase', { calls }, {});
      try {
        const pending = await h.say('pay mihir');
        expect(pending.body.question?.code).toBe('Q_AMOUNT_MISSING');
        const summary = await h.answer(pending, { text: '10 usd' });
        expect(summary.body.state, JSON.stringify(summary.body)).toBe('awaiting_confirmation');
        expect(summary.body.summary?.text).toContain('Send 10 USDC to Mihir');
        expect(summary.body.summary?.notes).toContain("You wrote '10 usd' → 10 USDC.");
        expect(h.llm.recorded.find((call) => call.name === 'request_type')?.user).toContain('pay mihir');
        expect(h.llm.recorded.find((call) => call.name === 'spans')?.user).toContain('pay mihir');
        expect(h.exec.submissions).toHaveLength(0);
        expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
        expect(h.envelope.intents).toHaveLength(1);
        expect(h.envelope.intents[0]).toMatchObject({
          intent_id: 'i',
          token: 'USDC',
          recipient: MIHIR,
          amount: { value: '10', base_units: '10000000', decimals: 6 },
        });
        expect(h.llm.names()).toEqual(['amounts', 'request_type', 'spans', 'payments']);
        expect(h.llm.remaining()).toEqual([]);
      } finally {
        await h.finish({ allowUnused: true });
      }
    },
  );

  it.each([
    { answer: '10 usd', amount: '10', token: 'USDC', units: '10000000' },
    { answer: '0.01 ETH', amount: '0.01', token: 'ETH', units: '10000000000000000' },
  ] as const)(
    'keeps $answer through confirmation and the submitted intent',
    async ({ answer, amount, token, units }) => {
      const h = new Harness('amount-answer-independent', missingFixture(), {});
      try {
        const pending = await h.say('send to mihir');
        expect(pending.body.question?.code).toBe('Q_AMOUNT_MISSING');
        const summary = await h.answer(pending, { text: answer });
        expect(summary.body.state, JSON.stringify(summary.body)).toBe('awaiting_confirmation');
        expect(summary.body.summary?.text).toContain(`Send ${amount} ${token} to Mihir`);
        expect(h.asked).toEqual(['Q_AMOUNT_MISSING']);
        expect(h.rows('SELECT amount, token, source, confirmed FROM db1_amount_placeholders')).toEqual([
          { amount, token, source: 'user', confirmed: 1 },
        ]);
        expect(h.exec.submissions).toHaveLength(0);
        expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
        expect(h.envelope.intents).toHaveLength(1);
        expect(h.envelope.intents[0]).toMatchObject({
          intent_id: 'i',
          token,
          amount: { value: amount, base_units: units, decimals: token === 'USDC' ? 6 : 18 },
          recipient: MIHIR,
        });
        expect(h.llm.names()).toEqual(['amounts', 'request_type', 'spans', 'payments']);
      } finally {
        await h.finish({ allowUnused: true });
      }
    },
  );
});

async function missingContext() {
  const ctx = await scannedCtx('pay mihir', {
    fixture: fx(
      { name: 'amounts', match: '', output: { amounts: [] } },
      { name: 'request_type', match: '', output: { request_type: 'actions', actions: ['i'], also_balance: false } },
    ),
  });
  expect(await s3.step(ctx)).toEqual({ kind: 'continue' });
  return ctx;
}

describe('amount answer value and interpretation guards', () => {
  it.each([
    {
      phrase: `0.${'0'.repeat(36)}1 USDC`,
      number: `0.${'0'.repeat(36)}1`,
      token: 'USDC',
      fiat: null,
      question: 'Q_AMOUNT_PRECISION',
    },
    {
      phrase: `0.${'0'.repeat(36)}1 ETH`,
      number: `0.${'0'.repeat(36)}1`,
      token: 'ETH',
      fiat: null,
      question: 'Q_AMOUNT_PRECISION',
    },
    { phrase: 'rs. 500', number: '500', token: null, fiat: 'OTHER', question: 'Q_FIAT_OTHER' },
    { phrase: '$50 worth of ETH', number: '50', token: 'ETH', fiat: 'USD', question: 'Q_FIAT_OTHER' },
  ] as const)(
    'a recognized monetary phrase $phrase retains its existing $question clarification',
    async ({ phrase, number, token, fiat, question }) => {
      const ctx = await scannedCtx(`send ${phrase} to mihir`, {
        fixture: fx({
          name: 'amounts',
          match: '',
          output: { amounts: [{ phrase, number, token, fiat, relative: null, role: 'pay' }] },
        }),
      });
      const result = await drive(s3, ctx);
      expect(result.result.kind).toBe('question');
      expect(result.questions.map((pending) => pending.code)).toEqual([question]);
      expect(ctx.req.amounts).toEqual([]);
      expect(ctx.repos.tables.db1.size).toBe(0);
    },
  );

  it.each(['50', null])(
    'a broad pay phrase with number %j cannot hide its recipient or expose an unmasked amount',
    async (number) => {
      const ctx = await scannedCtx('pay mihir 50 usdc', {
        fixture: fx({
          name: 'amounts',
          match: '',
          output: {
            amounts: [{ phrase: 'pay mihir 50 usdc', number, relative: null, token: 'USDC', fiat: null, role: 'pay' }],
          },
        }),
      });
      const result = await drive(s3, ctx, number === null ? [text('10 usd')] : []);
      if (result.result.kind === 'continue') {
        expect(ctx.req.masked_text_s3).toMatch(/^pay mihir /);
        expect(ctx.req.masked_text_s3).not.toMatch(/\b50\b/);
        expect(ctx.req.amounts).toHaveLength(1);
        expect(ctx.req.amounts[0]).toMatchObject({ amount: number ?? '10', token: 'USDC' });
      } else {
        // A model phrase that cannot be safely narrowed may stop or ask for clarification.
        expect(ctx.req.amounts).toEqual([]);
      }
    },
  );

  it('a single broad model phrase cannot merge two separately stated payment amounts', async () => {
    const typed = 'pay mihir 10 usdc and aradhya 20 usdc';
    const ctx = await scannedCtx(typed, {
      fixture: fx({
        name: 'amounts',
        match: '',
        output: {
          amounts: [{ phrase: typed, number: '10', relative: null, token: 'USDC', fiat: null, role: 'pay' }],
        },
      }),
    });
    const result = await drive(s3, ctx);
    if (result.result.kind === 'continue') {
      expect(ctx.req.masked_text_s3).toContain('mihir');
      expect(ctx.req.masked_text_s3).toContain('aradhya');
      expect(ctx.req.amounts.map((amount) => amount.amount)).toEqual(['10', '20']);
    } else {
      expect(ctx.req.amounts).toEqual([]);
    }
  });

  it.each([
    ['1USDC.e', '1', 'USDC'],
    ['0.000001 USD', '0.000001', 'USDC'],
    ['0.000000000000000001 ethereum', '0.000000000000000001', 'ETH'],
  ] satisfies Array<[string, string, Token]>)(
    'accepts the exact precision boundary in %s',
    async (answer, amount, token) => {
      const ctx = await missingContext();
      const result = await drive(s4, ctx, [text(answer)]);
      expect(result.questions.map((q) => q.code)).toEqual(['Q_AMOUNT_MISSING']);
      expect(result.result).toEqual({ kind: 'continue' });
      expect(ctx.req.amounts[0]).toMatchObject({ amount, token, code_verified: true });
      expect(ctx.llm.recorded.map((c) => c.name)).toEqual(['amounts', 'request_type']);
    },
  );

  it.each(['0.0000000000000000001 ETH', '1e3 USDC', '-10 USD', '10USDT', '10 USD and 1 ETH'])(
    'keeps invalid complete input %j out of DB1',
    async (answer) => {
      const ctx = await missingContext();
      const result = await drive(s4, ctx, [text(answer)]);
      expect(result.questions.map((q) => [q.code, q.attempt])).toEqual([
        ['Q_AMOUNT_MISSING', 1],
        ['Q_AMOUNT_MISSING', 2],
      ]);
      expect(ctx.req.amounts).toEqual([]);
      expect(ctx.repos.tables.db1.size).toBe(0);
    },
  );

  it('an invalid mixed-fiat reply cannot contaminate a later valid ETH answer', async () => {
    const ctx = await missingContext();
    const result = await drive(s4, ctx, [text('10 USD INR'), text('0.01 ether')]);
    expect(result.questions.map((q) => q.code)).toEqual(['Q_AMOUNT_MISSING', 'Q_AMOUNT_MISSING']);
    expect(result.result).toEqual({ kind: 'continue' });
    expect(ctx.req.amounts[0]).toMatchObject({ amount: '0.01', token: 'ETH', fiat: null });
    expect([...ctx.repos.tables.db1.values()]).toMatchObject([{ amount: '0.01', token: 'ETH' }]);
  });

  it('a bare high-precision amount is checked against the token chosen afterward', async () => {
    const ctx = await missingContext();
    const result = await drive(s4, ctx, [text('0.0000001'), chip('USDC')]);
    expect(result.questions.map((q) => q.code)).toEqual(['Q_AMOUNT_MISSING', 'Q_TOKEN', 'Q_AMOUNT_PRECISION']);
    expect(ctx.req.amounts).toEqual([]);
    expect(ctx.repos.tables.db1.size).toBe(0);
  });

  it.each(['s4 missing amount', 's3 replacement amount'])(
    'quotes the actual USD answer in the %s summary',
    async (route) => {
      const ctx = route.startsWith('s4')
        ? await missingContext()
        : await scannedCtx('send fifty eth to mihir', {
            fixture: fx({
              name: 'amounts',
              match: '',
              output: {
                amounts: [{ phrase: 'fifty eth', number: null, token: 'ETH', fiat: null, relative: null, role: 'pay' }],
              },
            }),
          });
      const result = await drive(route.startsWith('s4') ? s4 : s3, ctx, [text('10 usd')]);
      expect(result.result).toEqual({ kind: 'continue' });
      const amount = ctx.req.amounts[0]!;
      if (route.startsWith('s3')) {
        expect(amount.span?.text).toBe('fifty eth');
        expect(ctx.req.masked_text_s3).toBe(`send ${amount.placeholder} to mihir`);
      }
      const plan = [planI(0, amount.placeholder, addMihir(ctx), BASE, { token: amount.token })];
      const summary = buildSummary(ctx, plan);
      expect(summary.notes).toContain("You wrote '10 usd' → 10 USDC.");
      expect(summary.text).not.toContain("You wrote 'fifty eth'");
    },
  );
});

describe('document replacement validation before provenance changes', () => {
  it('retains the original row through a fiat/token conflict and promotes the same row only after a valid replacement', async () => {
    const ctx = await scannedCtx('pay this invoice', {
      fixture: fx({ name: 'amounts', match: '', output: { amounts: [] } }),
      req: { untrusted: [{ item_index: 0, address: null, ens_name: null, amount: '25', token: 'USDC' }] },
    });
    const fiat = await drive(s3, ctx, [chip('type_amount'), text('₹100 ETH')]);
    expect(fiat.questions.map((q) => q.code)).toEqual(['Q_UNTRUSTED_AMOUNT', 'Q_AMOUNT_MISSING', 'Q_FIAT_OTHER']);
    expect(fiat.result.kind).toBe('question');
    if (fiat.result.kind !== 'question') throw new Error('expected fiat question');
    const before = structuredClone([...ctx.repos.tables.db1.values()]);
    expect(before).toMatchObject([{ amount: '25', token: 'USDC', source: 'untrusted', confirmed: false }]);
    const conflict = await s3.onAnswer!(ctx, fiat.result.question, text('0.01 USD'));
    expect(conflict.kind).toBe('question');
    expect([...ctx.repos.tables.db1.values()]).toEqual(before);
    expect(ctx.req.amounts).toEqual([]);
    if (conflict.kind !== 'question') throw new Error('expected re-ask');
    expect(conflict.question).toMatchObject({ code: 'Q_FIAT_OTHER', attempt: 2 });
    expect(await s3.onAnswer!(ctx, conflict.question, text('0.01 ETH'))).toEqual({ kind: 'continue' });
    expect(await s3.step(ctx)).toEqual({ kind: 'continue' });
    const after = [...ctx.repos.tables.db1.values()];
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      placeholder: before[0]!.placeholder,
      amount: '0.01',
      token: 'ETH',
      source: 'user',
      confirmed: true,
    });
    expect(ctx.req.amounts[0]).toMatchObject({
      amount: '0.01',
      token: 'ETH',
      fiat: null,
      source: 'user',
      confirmed: true,
    });
  });
});
