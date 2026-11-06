// Independent grading of currency retention, summary provenance, and document replacement validation.
// HTTP cases use the real session manager and SQLCipher with fixture-only external services.
import { describe, expect, it } from 'vitest';
import { isAbsoluteAmountPhrase, parseAmountText } from '../../src/amounts/parse.js';
import type { Token } from '../../src/contracts/types.js';
import { buildSummary } from '../../src/messages/summary.js';
import { s3 } from '../../src/pipeline/s3-amounts.js';
import { s4 } from '../../src/pipeline/s4-type.js';
import type { FixtureFile } from '../fakes/llm.js';
import { chip, drive, fx, scannedCtx, text } from '../unit/B/helpers.js';
import { addMihir, BASE, planI } from '../unit/D/helpers.js';
import { ARADHYA, ARB, Harness, loadFixture, MIHIR, SEPOLIA } from './harness.js';

function missingFixture(): FixtureFile {
  const calls = structuredClone(loadFixture('A-55').calls);
  calls[0] = { name: 'amounts', match: 'send to mihir', output: { amounts: [] } };
  return { calls };
}

describe('amount answer currencies through HTTP', () => {
  it.each(
    [
      { label: 'recorded empty recipient output stays safe', spans: [], askRecipient: true },
      {
        label: 'an invented example recipient stays safe',
        spans: [{ text: 'neha', kind: 'name', role: 'payee' }],
        askRecipient: true,
      },
      {
        label: 'a mentioned-only recipient stays safe',
        spans: [{ text: 'mihir', kind: 'name', role: 'mentioned' }],
        askRecipient: true,
      },
      {
        label: 'corrected extraction preserves Mihir',
        spans: [{ text: 'mihir', kind: 'name', role: 'payee' }],
        askRecipient: false,
      },
      {
        label: 'the model-returned pronoun is not invented as a recipient',
        typed: 'pay her',
        spans: [{ text: 'her', kind: 'name', role: 'payee' }],
        askRecipient: true,
      },
    ].map((test) => ({ typed: 'pay mihir', ...test })),
  )('SQ-M-01: Qwen3 $label through thanks and a natural USD answer', async ({ typed, spans, askRecipient }) => {
    const fixture: FixtureFile = {
      calls: [
        { name: 'amounts', match: typed, output: { amounts: [] } },
        {
          name: 'request_type',
          match: typed,
          output: { request_type: 'actions', actions: ['i'], also_balance: false },
        },
        { name: 'conversation', match: 'thanks', output: { intent: 'clarify', value: null } },
        { name: 'conversation', match: 'please send 10 usd', output: { intent: 'answer', value: '10 usd' } },
        { name: 'spans', match: typed, output: { spans } },
        ...(askRecipient ? [] : [structuredClone(loadFixture('A-55').calls[3]!)]),
      ],
    };
    const h = new Harness('qwen3-empty-amount-and-recipient', fixture, {});
    try {
      const pending = await h.say(typed);
      expect(pending.body.question?.code).toBe('Q_AMOUNT_MISSING');
      const thanked = await h.answer(pending, { text: 'thanks' });
      expect(thanked.body.question).toEqual(pending.body.question);
      expect(thanked.body.request_id).toBe(pending.body.request_id);
      const summary = await h.answer(thanked, { text: 'please send 10 usd' });
      const recipientCall = h.llm.recorded.find((call) => call.name === 'spans');
      expect(recipientCall?.user).toContain(`Message: <<<${typed}>>>`);
      expect(recipientCall?.user).toContain('CANDIDATES: []');
      expect(recipientCall?.user).not.toContain('10 usd');
      expect(h.exec.submissions).toHaveLength(0);
      expect(summary.body.request_id).toBe(pending.body.request_id);
      expect(h.rows('SELECT amount, token, source, confirmed FROM db1_amount_placeholders')).toEqual([
        { amount: '10', token: 'USDC', source: 'user', confirmed: 1 },
      ]);
      if (askRecipient) {
        expect(summary.body.state).toBe('awaiting_answer');
        expect(summary.body.question?.code).toBe('Q_NO_PAYEE');
        expect(h.rows('SELECT * FROM db3_address_placeholders')).toEqual([]);
        expect(h.llm.names()).toEqual(['amounts', 'request_type', 'conversation', 'conversation', 'spans']);
        expect(h.llm.remaining()).toEqual([]);
        return;
      }
      expect(summary.body.state, JSON.stringify(summary.body)).toBe('awaiting_confirmation');
      expect(summary.body.summary?.text).toContain('Send 10 USDC to Mihir');
      expect(summary.body.summary?.notes).toContain("You wrote '10 usd' → 10 USDC.");
      expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
      expect(h.exec.submissions).toHaveLength(1);
      expect(h.envelope.intents).toHaveLength(1);
      expect(h.envelope.intents[0]).toMatchObject({
        intent_id: 'i',
        recipient: MIHIR,
        token: 'USDC',
        amount: { value: '10', base_units: '10000000', decimals: 6 },
      });
      expect(h.llm.remaining()).toEqual([]);
    } finally {
      await h.finish({ allowUnused: true });
    }
  });

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

describe('real-model follow-up amount shapes', () => {
  it('A-06: 5 more reuses the prior handed-off recipient, token and chain without adding to the prior amount', async () => {
    const fixture = structuredClone(loadFixture('A-06'));
    fixture.calls[4]!.output = {
      amounts: [{ phrase: '5 more', number: '5', relative: null, token: null, fiat: null, role: 'pay' }],
    };
    fixture.calls[5]!.match = 'Send';
    fixture.calls[6]!.match = 'Message:';
    const h = new Harness('amount-followup-real-shape', fixture, {
      balances: {
        [SEPOLIA]: { USDC: '0', ETH: '0.1' },
        [BASE]: { USDC: '30', ETH: '0.1' },
        [ARB]: { USDC: '60', ETH: '0.1' },
      },
    });
    try {
      const first = await h.say('Send 50 usdc to ARADHYA on base');
      expect(first.body.state).toBe('awaiting_confirmation');
      expect((await h.confirm(first, 'yes')).body.state).toBe('done');
      const original = structuredClone(h.envelope);
      const history = h.repos.db8.recentHistory(h.sessionId, 5);
      expect(history).toHaveLength(1);
      expect(original.intents.at(-1)).toMatchObject({
        intent_id: 'i',
        recipient: ARADHYA,
        token: 'USDC',
        chain_id: BASE,
        amount: { value: '50' },
      });
      h.advance(11);
      h.setBalances({ [BASE]: { USDC: '60' }, [ARB]: { USDC: '39' } });
      const summary = await h.say('Send 5 more');
      expect(summary.body.state, JSON.stringify(summary.body)).toBe('awaiting_confirmation');
      expect(summary.body.summary?.text).toContain('Send 5 USDC to Aradhya');
      expect(summary.body.summary?.notes).toContain('Recipient and chain from your last payment.');
      expect(h.asked).toEqual([]);
      expect(h.exec.submissions).toHaveLength(1);
      expect(h.repos.db8.recentHistory(h.sessionId, 5)).toEqual(history);
      expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
      expect(h.exec.submissions).toHaveLength(2);
      expect(h.exec.submissions[0]!.envelope).toEqual(original);
      expect(h.envelope.intents).toMatchObject([
        {
          intent_id: 'i',
          recipient: ARADHYA,
          token: 'USDC',
          chain_id: BASE,
          amount: { value: '5', base_units: '5000000', decimals: 6 },
        },
      ]);
      expect(h.repos.db8.recentHistory(h.sessionId, 5)).toHaveLength(2);
      expect(h.repos.db8.recentHistory(h.sessionId, 5).find((row) => row.request_id === first.body.request_id)).toEqual(
        history[0],
      );
      expect(h.count('db3_address_placeholders')).toBe(1);
      expect(h.llm.remaining()).toEqual([]);
    } finally {
      await h.finish({ allowUnused: true });
    }
  });

  it('A-07: 5 more without history asks for both token and recipient instead of inventing either', async () => {
    const fixture = structuredClone(loadFixture('A-07'));
    fixture.calls[0]!.output = {
      amounts: [{ phrase: '5 more', number: '5', relative: null, token: null, fiat: null, role: 'pay' }],
    };
    fixture.calls[1]!.match = 'send';
    fixture.calls[2]!.match = 'Message:';
    const h = new Harness('amount-followup-without-history', fixture, {});
    try {
      const token = await h.say('send 5 more');
      expect(token.body.question?.code).toBe('Q_TOKEN');
      const recipient = await h.answer(token, { chipLabel: 'USDC' });
      expect(recipient.body.question?.code).toBe('Q_NO_PAYEE');
      expect(h.asked).toEqual(['Q_TOKEN', 'Q_NO_PAYEE']);
      expect(h.rows('SELECT amount, token FROM db1_amount_placeholders')).toEqual([{ amount: '5', token: 'USDC' }]);
      expect(h.count('db3_address_placeholders')).toBe(0);
      expect(h.repos.db8.recentHistory(h.sessionId, 5)).toEqual([]);
      expect(h.exec.submissions).toHaveLength(0);
      expect(h.llm.remaining()).toEqual([]);
    } finally {
      await h.finish({ allowUnused: true });
    }
  });

  it('a fractional more answer preserves ETH and the prior recipient instead of defaulting to USDC', async () => {
    const initial = structuredClone(loadFixture('A-55').calls);
    initial[0] = {
      name: 'amounts',
      match: 'send 0.01 ETH',
      output: {
        amounts: [{ phrase: '0.01 ETH', number: '0.01', relative: null, token: 'ETH', fiat: null, role: 'pay' }],
      },
    };
    (initial[3]!.output as { payments: Array<{ chain: number | string }> }).payments[0]!.chain = ARB;
    const followup = structuredClone(loadFixture('A-06').calls.slice(4));
    followup[0] = {
      name: 'amounts',
      match: 'send 0.005 more',
      output: {
        amounts: [{ phrase: '0.005 more', number: '0.005', relative: null, token: null, fiat: null, role: 'pay' }],
      },
    };
    followup[1]!.match = 'send';
    followup[2]!.match = 'Message:';
    const h = new Harness('amount-followup-eth', { calls: [...initial, ...followup] }, {});
    try {
      const first = await h.say('send 0.01 ETH to mihir on arbitrum');
      expect(first.body.state).toBe('awaiting_confirmation');
      expect((await h.confirm(first, 'yes')).body.state).toBe('done');
      const summary = await h.say('send 0.005 more');
      expect(summary.body.state, JSON.stringify(summary.body)).toBe('awaiting_confirmation');
      expect(summary.body.summary?.text).toContain('Send 0.005 ETH to Mihir');
      expect(h.asked).toEqual([]);
      expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
      expect(h.exec.submissions[0]!.envelope.intents[0]).toMatchObject({ token: 'ETH', amount: { value: '0.01' } });
      expect(h.envelope.intents).toMatchObject([
        {
          intent_id: 'i',
          recipient: MIHIR,
          chain_id: ARB,
          token: 'ETH',
          amount: { value: '0.005', base_units: '5000000000000000', decimals: 18 },
        },
      ]);
      expect(h.llm.remaining()).toEqual([]);
    } finally {
      await h.finish({ allowUnused: true });
    }
  });

  it('5 more with an incorrect model value of 50 still requires numeric mismatch confirmation', async () => {
    const ctx = await scannedCtx('send 5 more', {
      fixture: fx({
        name: 'amounts',
        match: '',
        output: {
          amounts: [{ phrase: '5 more', number: '50', relative: null, token: null, fiat: null, role: 'pay' }],
        },
      }),
    });
    const result = await drive(s3, ctx);
    expect(result.questions[0]).toMatchObject({ code: 'Q_AMOUNT_MISMATCH', text: 'Did you mean 5 or 50?' });
    expect(ctx.req.amounts).toEqual([]);
    expect(ctx.repos.tables.db1.size).toBe(0);
  });

  it.each(['5 more to mihir', '5 more and send 20 usdc to aradhya'])(
    'the qualifier exemption cannot swallow extra instructions in %j',
    async (phrase) => {
      const ctx = await scannedCtx(`send ${phrase}`, {
        fixture: fx({
          name: 'amounts',
          match: '',
          output: {
            amounts: [{ phrase, number: '5', relative: null, token: 'USDC', fiat: null, role: 'pay' }],
          },
        }),
      });
      expect((await drive(s3, ctx)).result).toEqual({ kind: 'error', code: 'UNSUPPORTED_REQUEST' });
      expect(ctx.req.amounts).toEqual([]);
      expect(ctx.repos.tables.db1.size).toBe(0);
    },
  );

  it('the shared parser rejects a conditional reply instead of taking only its leading amount', () => {
    const phrase = '5 more if mihir agrees';
    expect(parseAmountText(phrase, 'USDC')).toEqual({ ok: false, reason: 'unparseable' });
    expect(isAbsoluteAmountPhrase(phrase)).toBe(false);
  });
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
