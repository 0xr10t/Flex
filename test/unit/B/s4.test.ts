// Tests: §8.5 S4 request type — C-101 (unsupported → UNSUPPORTED_REQUEST, ANSWERED), C-102 (balance → §13.2 answer),
// C-103 (empty actions → retry once → MODEL_FAILED), C-104 (remove l without a cancel word, SQB-14), C-105 (Q_RECURRING
// both directions and effects, SQB-21), C-106 (i/k without pay amounts → Q_AMOUNT_MISSING, answer mints an amount),
// C-107 (also_balance flag, SQB-15), C-314 (Q_RECURRING asked/validated/effect), C-307 (Q_AMOUNT_MISSING), C-143
// (prompt gets masked_text_s3), C-368 (UNSUPPORTED_REQUEST message), C-390 (MODEL_FAILED), C-415 (§17.2 step 5 new
// amount required), C-399 (LLM #2 never sees amounts or untrusted values), §18 labels. SPLIT_UNSUPPORTED is decided
// after S5 and tested in s5.test.ts (C-108).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_MESSAGE } from '../../../src/contracts/catalog.js';
import type { StepContext } from '../../../src/contracts/step.js';
import type { ActionKind } from '../../../src/contracts/types.js';
import { s3 } from '../../../src/pipeline/s3-amounts.js';
import { s4 } from '../../../src/pipeline/s4-type.js';
import { chip, drive, expectLabelsOk, scannedCtx, text } from './helpers.js';
import type { FixtureCall } from '../../fakes/llm.js';

vi.mock('../../../src/messages/balance.js', () => ({
  buildBalanceAnswer: vi.fn(() => ['BALANCE-ANSWER']),
}));
import { buildBalanceAnswer } from '../../../src/messages/balance.js';

type Amt = { phrase: string; number: string | null; token?: 'USDC' | 'ETH' | null };
const rt = (
  request_type: 'actions' | 'balance' | 'unsupported',
  actions: ActionKind[] = [],
  also_balance = false,
): FixtureCall => ({
  name: 'request_type',
  match: '',
  output: { request_type, actions, also_balance },
});

/** Runs the real S2 + S3 (amounts from `amounts`), then returns the context ready for S4. */
async function afterS3(typed: string, amounts: Amt[], rts: FixtureCall[]) {
  const ctx = await scannedCtx(typed, {
    fixture: {
      calls: [
        {
          name: 'amounts',
          match: typed,
          output: { amounts: amounts.map((a) => ({ relative: null, token: 'USDC', fiat: null, role: 'pay', ...a })) },
        },
        ...rts,
      ],
    },
  });
  const d = await drive(s3, ctx);
  if (d.result.kind !== 'continue') throw new Error(`S3 stopped: ${JSON.stringify(d.result)}`);
  return ctx;
}
const run = (ctx: StepContext, answers: Parameters<typeof drive>[2] = []) => drive(s4, ctx, answers);
const F5 = { phrase: '5 usdc', number: '5' };

beforeEach(() => vi.mocked(buildBalanceAnswer).mockClear());

describe('S4 request type', () => {
  it('C-143/C-399: LLM #2 receives masked_text_s3 (placeholders, no raw amounts)', async () => {
    const ctx = await afterS3('send 5 usdc to riya', [F5], [rt('actions', ['i'])]);
    await run(ctx);
    const call = ctx.llm.recorded.find((c) => c.name === 'request_type');
    expect(call?.user).toBe(`Message: <<<send ${ctx.req.amounts[0]?.placeholder} to riya>>>`);
    expect(call?.user).not.toContain('5 usdc');
  });

  it('actions i: continues; req.request_type/actions set; state TYPED', async () => {
    const ctx = await afterS3('send 5 usdc to riya', [F5], [rt('actions', ['i'])]);
    expect((await run(ctx)).result).toEqual({ kind: 'continue' });
    expect(ctx.req).toMatchObject({ request_type: 'actions', actions: ['i'], also_balance: false, state: 'TYPED' });
    expectLabelsOk(ctx as never);
  });

  it('§8.5 rule 1 (C-101, C-368): unsupported → UNSUPPORTED_REQUEST, final_state ANSWERED, catalog message', async () => {
    const ctx = await afterS3('swap 5 usdc for eth', [F5], [rt('unsupported')]);
    const { result } = await run(ctx);
    expect(result).toEqual({ kind: 'error', code: 'UNSUPPORTED_REQUEST', final_state: 'ANSWERED' });
    expect(ERROR_MESSAGE.UNSUPPORTED_REQUEST({})).toBe(
      "I can send USDC or ETH, set up or stop repeating payments, and show balances. I can't help with that part.",
    );
  });

  it('§8.5 rule 2 (C-102): balance → the §13.2 balance answer (buildBalanceAnswer), kind answer', async () => {
    const ctx = await afterS3('what is my balance', [], [rt('balance')]);
    const { result } = await run(ctx);
    expect(result).toEqual({ kind: 'answer', messages: ['BALANCE-ANSWER'] });
    expect(buildBalanceAnswer).toHaveBeenCalledTimes(1);
    expect(buildBalanceAnswer).toHaveBeenCalledWith(ctx);
    expect(ctx.req.request_type).toBe('balance');
  });

  it('§8.5 rule 3 (C-103): empty actions → the call is retried once; a non-empty second answer is used', async () => {
    const ctx = await afterS3('send 5 usdc to riya', [F5], [rt('actions', []), rt('actions', ['i'])]);
    expect((await run(ctx)).result).toEqual({ kind: 'continue' });
    expect(ctx.llm.recorded.filter((c) => c.name === 'request_type')).toHaveLength(2);
    expect(ctx.req.actions).toEqual(['i']);
  });

  it('§8.5 rule 3 (C-103, C-390): still empty → MODEL_FAILED', async () => {
    const ctx = await afterS3('send 5 usdc to riya', [F5], [rt('actions', []), rt('actions', [])]);
    expect((await run(ctx)).result).toEqual({ kind: 'error', code: 'MODEL_FAILED' });
  });

  it('C-390: LLM #2 failing twice (error/invalid) → MODEL_FAILED', async () => {
    const ctx = await afterS3(
      'send 5 usdc to riya',
      [F5],
      [
        { name: 'request_type', match: '', output: null },
        { name: 'request_type', match: '', output: { bad: 1 }, attempt: 2 },
      ],
    );
    expect((await run(ctx)).result).toEqual({ kind: 'error', code: 'MODEL_FAILED' });
  });

  it('§8.5 rule 3 (C-104): l is removed when S2 found no cancel word; nothing else is removed', async () => {
    const ctx = await afterS3('send 5 usdc to riya', [F5], [rt('actions', ['i', 'l'])]);
    await run(ctx);
    expect(ctx.req.actions).toEqual(['i']);
  });

  it('§8.5 rule 3 (C-104): l is kept with a cancel word', async () => {
    const ctx = await afterS3('stop paying riya', [], [rt('actions', ['l'])]);
    expect((await run(ctx)).result).toEqual({ kind: 'continue' });
    expect(ctx.req.actions).toEqual(['l']);
  });

  it('SQB-14: only l without a cancel word leaves no actions → UNSUPPORTED_REQUEST + rule_id S4_ONLY_L_WITHOUT_CANCEL_WORD', async () => {
    const ctx = await afterS3('please do the thing for riya', [], [rt('actions', ['l'])]);
    expect((await run(ctx)).result).toEqual({ kind: 'error', code: 'UNSUPPORTED_REQUEST' });
    expect(ctx.log.lines.find((l) => l.event === 'unsupported_state')).toMatchObject({
      rule_id: 'S4_ONLY_L_WITHOUT_CANCEL_WORD',
      step: 's4',
    });
    expectLabelsOk(ctx as never);
  });

  it('§8.5 rule 3 (C-107, SQB-15): also_balance is carried on the request', async () => {
    const ctx = await afterS3('send 5 usdc to riya and show my balance', [F5], [rt('actions', ['i'], true)]);
    expect((await run(ctx)).result).toEqual({ kind: 'continue' });
    expect(ctx.req.also_balance).toBe(true);
    expect(buildBalanceAnswer).not.toHaveBeenCalled(); // S11 puts it first in the summary response
  });
});

describe('S4 recurrence cross-check (C-105, C-314, SQB-21)', () => {
  it('k without a recurrence phrase → Q_RECURRING (chips "Yes, repeat it" / "No, just once"); Yes keeps k', async () => {
    const ctx = await afterS3('send 5 usdc to riya', [F5], [rt('actions', ['k'])]);
    const r = await run(ctx, [chip('repeat')]);
    expect(r.questions[0]).toMatchObject({
      code: 'Q_RECURRING',
      input: 'chips',
      text: 'Should this payment repeat?',
      attempt: 1,
    });
    expect(r.questions[0]?.chips.map((c) => c.label)).toEqual(['Yes, repeat it', 'No, just once']);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(ctx.req.actions).toEqual(['k']);
  });

  it('k without a recurrence phrase, "No, just once" → i instead of k', async () => {
    const ctx = await afterS3('send 5 usdc to riya', [F5], [rt('actions', ['k'])]);
    const r = await run(ctx, [chip('once')]);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(ctx.req.actions).toEqual(['i']);
  });

  it('no k but a recurrence phrase and pay amounts → Q_RECURRING; Yes → k replaces i; No → i', async () => {
    const yes = await afterS3('send 5 usdc to riya every friday', [F5], [rt('actions', ['i'])]);
    const r1 = await run(yes, [text('Yes, repeat it')]);
    expect(r1.questions[0]?.code).toBe('Q_RECURRING');
    expect(yes.req.actions).toEqual(['k']);
    const no = await afterS3('send 5 usdc to riya every friday', [F5], [rt('actions', ['i'])]);
    await run(no, [chip('once')]);
    expect(no.req.actions).toEqual(['i']);
  });

  it('Yes with a pay amount outside the recurrence clause keeps i as well (i + k)', async () => {
    const ctx = await afterS3(
      'send 5 usdc to riya every friday and 3 usdc to mihir',
      [F5, { phrase: '3 usdc', number: '3' }],
      [rt('actions', ['i'])],
    );
    await run(ctx, [chip('repeat')]);
    expect(ctx.req.actions).toEqual(['i', 'k']);
  });

  it('no question when k and a recurrence phrase agree, or when there is a recurrence phrase but no pay amounts', async () => {
    const a = await afterS3('send 5 usdc to riya every friday', [F5], [rt('actions', ['k'])]);
    const ra = await run(a);
    expect(ra.questions).toEqual([]);
    expect(a.req.actions).toEqual(['k']);
    const b = await afterS3('stop paying riya every friday', [], [rt('actions', ['l'])]);
    expect((await run(b)).questions).toEqual([]);
  });

  it('an invalid Q_RECURRING answer re-asks with attempt + 1', async () => {
    const ctx = await afterS3('send 5 usdc to riya', [F5], [rt('actions', ['k'])]);
    const r = await run(ctx, [text('maybe'), chip('repeat')]);
    expect(r.questions.map((x) => x.attempt)).toEqual([1, 2]);
    expect(r.questions[1]?.text).toBe('Should this payment repeat?');
    expect(new Set(r.questions.map((x) => x.question_id)).size).toBe(2);
  });
});

describe('S4 i/k without pay amounts (C-106, C-307, C-415)', () => {
  it('no pay amount → Q_AMOUNT_MISSING; the answer mints an amount (user/phrase/confirmed) with the inferred token', async () => {
    const ctx = await afterS3('pay riya in usdc', [], [rt('actions', ['i'])]);
    const r = await run(ctx, [text('12.5')]);
    expect(r.questions[0]).toMatchObject({
      code: 'Q_AMOUNT_MISSING',
      input: 'number',
      text: 'How much should I send?',
    });
    expect(r.result).toEqual({ kind: 'continue' });
    expect(ctx.req.amounts).toHaveLength(1);
    const a = ctx.req.amounts[0];
    expect(a).toMatchObject({
      amount: '12.5',
      token: 'USDC',
      phrase: null,
      span: null,
      source: 'user',
      origin: 'phrase',
      confirmed: true,
    });
    expect(ctx.repos.db1.get(a!.placeholder)).toMatchObject({
      amount: '12.5',
      token: 'USDC',
      source: 'user',
      origin: 'phrase',
      confirmed: true,
    });
  });

  it('unknown token → Q_TOKEN after the number; bad numbers re-ask', async () => {
    const ctx = await afterS3('pay riya', [], [rt('actions', ['i'])]);
    const r = await run(ctx, [text('abc'), text('1,000'), chip('ETH')]);
    expect(r.questions.map((x) => [x.code, x.attempt])).toEqual([
      ['Q_AMOUNT_MISSING', 1],
      ['Q_AMOUNT_MISSING', 2],
      ['Q_TOKEN', 1],
    ]);
    expect(ctx.req.amounts[0]).toMatchObject({ amount: '1000', token: 'ETH' });
  });

  it('l alone needs no amount', async () => {
    const ctx = await afterS3('stop paying riya', [], [rt('actions', ['l'])]);
    const r = await run(ctx);
    expect(r.questions).toEqual([]);
    expect(ctx.req.amounts).toEqual([]);
  });

  it('§17.2 step 5: a follow-up ("again") still needs a new amount', async () => {
    const ctx = await afterS3('pay her again', [], [rt('actions', ['i'])]);
    expect((await run(ctx)).questions[0]?.code).toBe('Q_AMOUNT_MISSING');
  });

  it('S4 resumes: step() after completion continues without another LLM call', async () => {
    const ctx = await afterS3('send 5 usdc to riya', [F5], [rt('actions', ['i'])]);
    await run(ctx);
    const n = ctx.llm.recorded.length;
    expect(await s4.step(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.llm.recorded).toHaveLength(n);
  });
});
