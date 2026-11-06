// Tests: §8.4 S3 amounts (C-445 §20.1 amounts/verify) — C-088 (prompt input is the unmasked typed text), C-089 (rule 1 verbatim, first unused
// occurrence), C-090 (rule 2 context dropped, [amount]), C-091 (rule 3 number null → Q_AMOUNT_MISSING; SQB-06),
// C-092 (code parse equality → Q_AMOUNT_MISMATCH), C-093 (token inference (a)–(e), fiat rules), C-094 (precision, zero),
// C-095 (uncovered numbers), C-096 (mint DB1 user/phrase/confirmed), C-097 (relative amounts, chain pinning, SQB-11,
// SQB-20), C-098 (document amounts), C-099 (no pay amounts → continue), C-100 (masked_text_s3), C-307…C-313 (question
// asked / answer validated / effect), C-333 (number answers via parseAmountText), C-390 (MODEL_FAILED), C-416 (previous
// token, §17.2 step 6, SQB-13), C-398 (each untrusted amount needs Q_UNTRUSTED_AMOUNT), C-404 (context amounts never
// stored), C-299 (note), §9.7 re-ask attempt + 1, §18 log labels.
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE, QUESTION_TEXT } from '../../../src/contracts/catalog.js';
import type { StepResult } from '../../../src/contracts/step.js';
import type { QItem } from '../../../src/contracts/types.js';
import { s3 } from '../../../src/pipeline/s3-amounts.js';
import type { TestContext } from '../../fakes/context.js';
import { seedBalances } from '../../fakes/repos.js';
import { chip, drive, expectLabelsOk, fx, scannedCtx, text } from './helpers.js';

type A = {
  phrase: string;
  number: string | null;
  relative?: 'all' | 'half' | 'max' | null;
  token?: 'USDC' | 'ETH' | null;
  fiat?: 'USD' | 'OTHER' | null;
  role?: 'pay' | 'context';
};
const amt = (a: A) => ({ relative: null, token: null, fiat: null, role: 'pay' as const, ...a });
const llm = (match: string, ...a: A[]) => ({ name: 'amounts' as const, match, output: { amounts: a.map(amt) } });

async function run(
  typed: string,
  amounts: A[],
  answers: Parameters<typeof drive>[2] = [],
  pre?: (c: TestContext) => void,
) {
  const ctx = await scannedCtx(typed, { fixture: fx(llm(typed, ...amounts)) });
  pre?.(ctx);
  const d = await drive(s3, ctx, answers);
  return { ctx, ...d };
}
const q = (r: { result: StepResult }) => (r.result.kind === 'question' ? r.result.question : null);
const PH = /^amount_[0-9a-f]{8}$/;

describe('S3 rules 1-2 and 8 (verbatim, context, none)', () => {
  it('C-088: the LLM #1 prompt carries the UNMASKED typed text', async () => {
    const { ctx } = await run('send 50 usdc to aradhya', [{ phrase: '50 usdc', number: '50', token: 'USDC' }]);
    expect(ctx.llm.recorded.map((c) => c.name)).toEqual(['amounts']);
    expect(ctx.llm.recorded[0]?.user).toBe('Message: <<<send 50 usdc to aradhya>>>');
  });

  it('§8.4 rule 5 (C-096, C-100): mints DB1 user/phrase/confirmed, replaces the phrase in masked_text_s3, req.amounts filled', async () => {
    const { ctx, result } = await run('send 50 usdc to aradhya on base', [
      { phrase: '50 usdc', number: '50', token: 'USDC' },
    ]);
    expect(result).toEqual({ kind: 'continue' });
    expect(ctx.req.amounts).toHaveLength(1);
    const a = ctx.req.amounts[0];
    expect(a?.placeholder).toMatch(PH);
    expect(a).toMatchObject({
      phrase: '50 usdc',
      amount: '50',
      token: 'USDC',
      source: 'user',
      origin: 'phrase',
      confirmed: true,
      relative: null,
      fiat: null,
      pinned_chain_id: null,
      code_verified: true,
    });
    expect(a?.span).toMatchObject({ text: '50 usdc', start: 5, end: 12 });
    const row = ctx.repos.db1.get(a!.placeholder);
    expect(row).toMatchObject({
      amount: '50',
      token: 'USDC',
      source: 'user',
      origin: 'phrase',
      confirmed: true,
      session_id: ctx.req.session_id,
      request_id: ctx.req.request_id,
    });
    expect(ctx.req.masked_text_s3).toBe(`send ${a?.placeholder} to aradhya on base`);
    expect(ctx.req.state).toBe('AMOUNTS_MASKED');
    expectLabelsOk(ctx);
  });

  it('§8.4 rule 1 (C-089): a phrase not verbatim (case-sensitive) is dropped; its number then shows up as uncovered', async () => {
    const r = await run('send 50 usdc to riya', [{ phrase: '50 USDC', number: '50', token: 'USDC' }]);
    expect(r.ctx.req.amounts).toEqual([]);
    expect(q(r)?.code).toBe('Q_AMOUNT_UNCOVERED');
    const r2 = await run('send 50 usdc to riya', [{ phrase: 'fifty usdc', number: '50' }], [chip('no')]);
    expect(r2.result).toEqual({ kind: 'continue' });
    expect(r2.ctx.req.amounts).toEqual([]);
    expect(r2.ctx.repos.tables.db1.size).toBe(0);
  });

  it('§8.4 rule 1 (C-089): equal phrases map to the first unused occurrence, in order', async () => {
    const { ctx } = await run('send 5 usdc to a and 5 usdc to b', [
      { phrase: '5 usdc', number: '5', token: 'USDC' },
      { phrase: '5 usdc', number: '5', token: 'USDC' },
    ]);
    expect(ctx.req.amounts.map((a) => a.span?.start)).toEqual([5, 21]);
    expect(ctx.req.masked_text_s3).toBe(
      `send ${ctx.req.amounts[0]?.placeholder} to a and ${ctx.req.amounts[1]?.placeholder} to b`,
    );
    expect(new Set(ctx.req.amounts.map((a) => a.placeholder)).size).toBe(2);
  });

  it('§8.4 rule 2 (C-090, C-404): role=context is dropped silently — masked as [amount], no row, not in req.amounts', async () => {
    const { ctx } = await run('pay mihir 50 usdc, he charged 500 last time', [
      { phrase: '50 usdc', number: '50', token: 'USDC' },
      { phrase: '500', number: '500', role: 'context' },
    ]);
    expect(ctx.req.amounts).toHaveLength(1);
    expect(ctx.repos.tables.db1.size).toBe(1);
    expect(ctx.req.masked_text_s3).toBe(`pay mihir ${ctx.req.amounts[0]?.placeholder}, he charged [amount] last time`);
    expect(JSON.stringify([...ctx.repos.tables.db1.values()])).not.toContain('500');
    expect(ctx.req.notes).toEqual([]);
  });

  it('§8.4 rule 8 (C-099): no pay amounts → continue with masked_text_s3 = typed text', async () => {
    const { ctx, result } = await run('stop paying riya', []);
    expect(result).toEqual({ kind: 'continue' });
    expect(ctx.req.amounts).toEqual([]);
    expect(ctx.req.masked_text_s3).toBe('stop paying riya');
  });

  it('C-390: LLM #1 failing twice → MODEL_FAILED with the catalog message', async () => {
    const typed = 'send 5 usdc to a';
    const ctx = await scannedCtx(typed, {
      fixture: fx(
        { name: 'amounts', match: typed, output: null },
        { name: 'amounts', match: typed, output: null, attempt: 2 },
      ),
    });
    const r = await s3.step(ctx);
    expect(r).toEqual({ kind: 'error', code: 'MODEL_FAILED' });
    expect(ERROR_MESSAGE.MODEL_FAILED({})).toBe("I couldn't understand that right now. Please try again.");
    expect(ctx.repos.tables.db1.size).toBe(0);
  });

  it('C-390: invalid output once then a valid retry is accepted', async () => {
    const typed = 'send 5 usdc to a';
    const ctx = await scannedCtx(typed, {
      fixture: fx(
        { name: 'amounts', match: typed, output: { amounts: 'x' } },
        {
          name: 'amounts',
          match: typed,
          output: { amounts: [amt({ phrase: '5 usdc', number: '5', token: 'USDC' })] },
          attempt: 2,
        },
      ),
    });
    expect((await s3.step(ctx)).kind).toBe('continue');
    expect(ctx.req.amounts).toHaveLength(1);
  });
});

describe('S3 rule 3 (number, parse, mismatch)', () => {
  it('C-091/C-307: number null → Q_AMOUNT_MISSING (number input); the answer is parsed by parseAmountText (C-333) and minted', async () => {
    const r = await run(
      'send fifty usdc to riya',
      [{ phrase: 'fifty usdc', number: null, token: 'USDC' }],
      [text('1,250.5')],
    );
    expect(r.questions[0]).toMatchObject({
      code: 'Q_AMOUNT_MISSING',
      input: 'number',
      attempt: 1,
      max_attempts: 4,
      text: 'How much should I send?',
    });
    expect(r.result).toEqual({ kind: 'continue' });
    expect(r.ctx.req.amounts[0]).toMatchObject({ amount: '1250.5', token: 'USDC', code_verified: true });
  });

  it('C-333: number answers accept k / lakh / commas (via parseAmountText)', async () => {
    for (const [ans, val] of [
      ['5k', '5000'],
      ['2 lakh', '200000'],
      ['0.25', '0.25'],
    ] as const) {
      const r = await run(
        'send some usdc to riya',
        [{ phrase: 'some usdc', number: null, token: 'USDC' }],
        [text(ans)],
      );
      expect(r.ctx.req.amounts[0]?.amount, ans).toBe(val);
    }
  });

  it('§9.7 / §13.4: invalid number answers re-ask the same question with attempt + 1 (new id), zero adds the hint', async () => {
    const r = await run(
      'send some usdc to riya',
      [{ phrase: 'some usdc', number: null, token: 'USDC' }],
      [text('abc'), text('0'), chip('yes'), text('7')],
    );
    expect(r.questions.map((x) => [x.code, x.attempt])).toEqual([
      ['Q_AMOUNT_MISSING', 1],
      ['Q_AMOUNT_MISSING', 2],
      ['Q_AMOUNT_MISSING', 3],
      ['Q_AMOUNT_MISSING', 4],
    ]);
    expect(new Set(r.questions.map((x) => x.question_id)).size).toBe(4);
    expect(r.questions[1]?.text).toBe('How much should I send?');
    expect(r.questions[2]?.text).toBe('amount must be more than 0 How much should I send?');
    expect(r.result).toEqual({ kind: 'continue' });
    expect(r.ctx.req.amounts[0]?.amount).toBe('7');
  });

  it('SQB-06: a non-null number that is not a plain decimal → UNSUPPORTED_REQUEST + log rule_id S3_NUMBER_PATTERN', async () => {
    const { ctx, result } = await run('send 1,000 usdc to riya', [
      { phrase: '1,000 usdc', number: '1,000', token: 'USDC' },
    ]);
    expect(result).toEqual({ kind: 'error', code: 'UNSUPPORTED_REQUEST' });
    expect(ctx.log.lines.find((l) => l.event === 'unsupported_state')).toMatchObject({
      rule_id: 'S3_NUMBER_PATTERN',
      step: 's3',
    });
    expectLabelsOk(ctx);
  });

  it('§8.4 rule 3 (C-092, C-308): code parse differs from the LLM number → Q_AMOUNT_MISMATCH with both values as chips', async () => {
    const typed = 'send 5k usdc to riya';
    const mk = () => run(typed, [{ phrase: '5k', number: '500', token: 'USDC' }]);
    const r = await mk();
    const mq = q(r);
    expect(mq).toMatchObject({ code: 'Q_AMOUNT_MISMATCH', input: 'chips', text: 'Did you mean 5000 or 500?' });
    expect(mq?.chips.map((c) => c.label).sort()).toEqual(['500', '5000']);
    // chip effects
    const idCode = mq!.chips.find((c) => c.label === '5000')!.id;
    const idLlm = mq!.chips.find((c) => c.label === '500')!.id;
    const a = await run(typed, [{ phrase: '5k', number: '500', token: 'USDC' }], [chip(idCode)]);
    expect(a.result).toEqual({ kind: 'continue' });
    expect(a.ctx.req.amounts[0]).toMatchObject({ amount: '5000', code_verified: true });
    const b = await run(typed, [{ phrase: '5k', number: '500', token: 'USDC' }], [chip(idLlm)]);
    expect(b.ctx.req.amounts[0]).toMatchObject({ amount: '500', code_verified: false });
    // a free-text answer equal to a chip label also matches; garbage re-asks
    const c = await run(typed, [{ phrase: '5k', number: '500', token: 'USDC' }], [text('nope'), text('5000')]);
    expect(c.questions.map((x) => x.attempt)).toEqual([1, 2]);
    expect(c.ctx.req.amounts[0]?.amount).toBe('5000');
  });

  it('no mismatch when the code parse equals the LLM number (5k = 5000, 1.50 = 1.5)', async () => {
    const r = await run('send 5k usdc to riya', [{ phrase: '5k', number: '5000', token: 'USDC' }]);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(r.ctx.req.amounts[0]).toMatchObject({ amount: '5000', code_verified: true });
    const r2 = await run('send 1.50 usdc to riya', [{ phrase: '1.50', number: '1.5', token: 'USDC' }]);
    expect(r2.ctx.req.amounts[0]?.amount).toBe('1.5');
  });
});

describe('S3 token inference (§8.4 step 3 (a)–(e), C-093, C-311, C-416)', () => {
  it('(a) the LLM token field wins', async () => {
    const { ctx } = await run('send 0.5 eth to riya', [{ phrase: '0.5 eth', number: '0.5', token: 'ETH' }]);
    expect(ctx.req.amounts[0]?.token).toBe('ETH');
  });

  it('(b) fiat USD → USDC', async () => {
    const { ctx } = await run('pay mihir fifty bucks', [{ phrase: 'fifty bucks', number: '50', fiat: 'USD' }]);
    expect(ctx.req.amounts[0]).toMatchObject({ token: 'USDC', amount: '50', fiat: 'USD' });
  });

  it("(c) a token word in the amount's own clause wins over other clauses", async () => {
    const { ctx } = await run('send 5 to riya in eth and 7 to mihir in usdc', [
      { phrase: '5', number: '5' },
      { phrase: '7', number: '7' },
    ]);
    expect(ctx.req.amounts.map((a) => a.token)).toEqual(['ETH', 'USDC']);
  });

  it('(d) exactly one token word in the whole prompt applies to every amount without a token', async () => {
    const { ctx } = await run('send 5 to riya, 7 to mihir, in usdc', [
      { phrase: '5', number: '5' },
      { phrase: '7', number: '7' },
    ]);
    expect(ctx.req.amounts.map((a) => a.token)).toEqual(['USDC', 'USDC']);
  });

  it('(e) otherwise Q_TOKEN with USDC / ETH chips; the chip sets the token; invalid answers re-ask', async () => {
    const typed = 'send 5 to riya, 6 usdc to a, 0.1 eth to b';
    const r = await run(
      typed,
      [
        { phrase: '5', number: '5' },
        { phrase: '6 usdc', number: '6', token: 'USDC' },
        { phrase: '0.1 eth', number: '0.1', token: 'ETH' },
      ],
      [text('dogecoin'), chip('ETH')],
    );
    expect(r.questions[0]).toMatchObject({ code: 'Q_TOKEN', input: 'chips', text: 'Is 5 in USDC or ETH?', attempt: 1 });
    expect(r.questions[0]?.chips.map((c) => c.id)).toEqual(['USDC', 'ETH']);
    expect(r.questions[1]?.attempt).toBe(2);
    expect(r.ctx.req.amounts.map((a) => a.token)).toEqual(['ETH', 'USDC', 'ETH']);
    const u = await run(
      typed,
      [
        { phrase: '5', number: '5' },
        { phrase: '6 usdc', number: '6', token: 'USDC' },
        { phrase: '0.1 eth', number: '0.1', token: 'ETH' },
      ],
      [text('usdc')],
    );
    expect(u.ctx.req.amounts[0]?.token).toBe('USDC'); // a chip label typed as text matches the chip
  });

  it('§17.2 step 6 (C-416, SQB-13): back-reference + previous payment with one token → that token, no Q_TOKEN', async () => {
    const typed = 'send 5 more to riya';
    const ctx = await scannedCtx(typed, { fixture: fx(llm(typed, { phrase: '5', number: '5' })) });
    expect(ctx.req.scan.back_reference.length).toBeGreaterThan(0);
    const ph = ctx.repos.db1.mint({
      session_id: ctx.req.session_id,
      request_id: 'req_000000000000' as never,
      amount: '1',
      token: 'ETH',
      source: 'user',
      origin: 'phrase',
      confirmed: true,
    });
    ctx.repos.db8.appendHistory({
      session_id: ctx.req.session_id,
      request_id: 'req_000000000000',
      payments_json: JSON.stringify([{ kind: 'i', amount: ph, recipient: 'address_aaaaaaaa', chain: 'unstated' }]),
      handed_off_at: '2026-11-05T10:00:00.000Z',
    });
    const d = await drive(s3, ctx);
    expect(d.result).toEqual({ kind: 'continue' });
    expect(ctx.req.amounts[0]?.token).toBe('ETH');
  });

  it('§17.2 step 6: previous payments with two different tokens → Q_TOKEN', async () => {
    const typed = 'send 5 more to riya';
    const ctx = await scannedCtx(typed, { fixture: fx(llm(typed, { phrase: '5', number: '5' })) });
    ctx.repos.db8.appendHistory({
      session_id: ctx.req.session_id,
      request_id: 'req_000000000000',
      payments_json: JSON.stringify([{ token: 'ETH' }, { token: 'USDC' }]),
      handed_off_at: '2026-11-05T10:00:00.000Z',
    });
    const d = await drive(s3, ctx);
    expect(d.questions[0]?.code).toBe('Q_TOKEN');
  });

  it('§17.2 step 6: no back-reference word → history is not consulted (Q_TOKEN)', async () => {
    const typed = 'send 5 to riya';
    const ctx = await scannedCtx(typed, { fixture: fx(llm(typed, { phrase: '5', number: '5' })) });
    ctx.repos.db8.appendHistory({
      session_id: ctx.req.session_id,
      request_id: 'req_000000000000',
      payments_json: JSON.stringify([{ token: 'ETH' }]),
      handed_off_at: 'x',
    });
    expect((await drive(s3, ctx)).questions[0]?.code).toBe('Q_TOKEN');
  });
});

describe('S3 fiat, precision, zero (C-093, C-094, C-310, C-312)', () => {
  it('R2-3: a typed non-USD marker (₹) wins over an LLM that says fiat USD → Q_FIAT_OTHER', async () => {
    const r = await run(
      'send ₹500 to riya',
      [{ phrase: '₹500', number: '500', fiat: 'USD' }],
      [text('6'), chip('USDC')],
    );
    expect(r.questions[0]?.code).toBe('Q_FIAT_OTHER');
    expect(r.ctx.req.amounts[0]).toMatchObject({ amount: '6' });
  });

  it('fiat OTHER → Q_FIAT_OTHER; a number answer then Q_TOKEN for the token', async () => {
    const r = await run(
      'pay riya 5000 rupees',
      [{ phrase: '5000 rupees', number: '5000', fiat: 'OTHER' }],
      [text('60'), chip('USDC')],
    );
    expect(r.questions[0]).toMatchObject({
      code: 'Q_FIAT_OTHER',
      input: 'number',
      text: "I can't convert 5000 rupees. How much in USDC or ETH?",
    });
    expect(r.questions[1]?.code).toBe('Q_TOKEN');
    expect(r.ctx.req.amounts[0]).toMatchObject({ amount: '60', token: 'USDC' });
  });

  it('fiat USD with an ETH token → Q_FIAT_OTHER naming ETH; the answer is in ETH', async () => {
    const r = await run(
      'send $50 of eth to riya',
      [{ phrase: '$50 of eth', number: '50', token: 'ETH', fiat: 'USD' }],
      [text('0.02')],
    );
    expect(r.questions[0]).toMatchObject({
      code: 'Q_FIAT_OTHER',
      text: "I can't convert $50 of eth. How much in ETH?",
    });
    expect(r.result).toEqual({ kind: 'continue' });
    expect(r.ctx.req.amounts[0]).toMatchObject({ amount: '0.02', token: 'ETH' });
  });

  it('precision beyond the token decimals → Q_AMOUNT_PRECISION; too-precise answers re-ask', async () => {
    const r = await run(
      'send 0.0000001 usdc to riya',
      [{ phrase: '0.0000001 usdc', number: '0.0000001', token: 'USDC' }],
      [text('0.0000001'), text('0.5')],
    );
    expect(r.questions[0]).toMatchObject({
      code: 'Q_AMOUNT_PRECISION',
      text: 'USDC supports up to 6 decimal places. How much exactly?',
    });
    expect(r.questions[1]?.attempt).toBe(2);
    expect(r.ctx.req.amounts[0]?.amount).toBe('0.5');
    const eth = await run('send 0.0000000000000000001 eth to riya', [
      { phrase: '0.0000000000000000001 eth', number: '0.0000000000000000001', token: 'ETH' },
    ]);
    expect(q(eth)?.text).toBe('ETH supports up to 18 decimal places. How much exactly?');
    const ok6 = await run('send 0.000001 usdc to riya', [
      { phrase: '0.000001 usdc', number: '0.000001', token: 'USDC' },
    ]);
    expect(ok6.result.kind).toBe('continue');
  });

  it('zero → Q_AMOUNT_MISSING with the hint "amount must be more than 0"', async () => {
    const r = await run('send 0 usdc to riya', [{ phrase: '0 usdc', number: '0', token: 'USDC' }], [text('3')]);
    expect(r.questions[0]).toMatchObject({
      code: 'Q_AMOUNT_MISSING',
      text: 'amount must be more than 0 How much should I send?',
    });
    expect(r.ctx.req.amounts[0]?.amount).toBe('3');
  });
});

describe('S3 rule 4 uncovered numbers (C-095, C-309)', () => {
  const typed = 'send 50 usdc to riya and 30 to mihir';
  const first = { phrase: '50 usdc', number: '50', token: 'USDC' as const };

  it('an uncovered numeric candidate → Q_AMOUNT_UNCOVERED Yes/No; Yes makes it a pay amount (token inferred)', async () => {
    const r = await run(typed, [first], [chip('yes')]);
    expect(r.questions[0]).toMatchObject({ code: 'Q_AMOUNT_UNCOVERED', text: 'Should 30 be paid?', input: 'chips' });
    expect(r.questions[0]?.chips.map((c) => c.id)).toEqual(['yes', 'no']);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(r.ctx.req.amounts.map((a) => [a.amount, a.token])).toEqual([
      ['50', 'USDC'],
      ['30', 'USDC'],
    ]);
    expect(r.ctx.req.masked_text_s3).toBe(
      `send ${r.ctx.req.amounts[0]?.placeholder} to riya and ${r.ctx.req.amounts[1]?.placeholder} to mihir`,
    );
  });

  it('No → the number is ignored (left in the masked text), nothing minted for it', async () => {
    const r = await run(typed, [first], [text('No')]);
    expect(r.ctx.req.amounts).toHaveLength(1);
    expect(r.ctx.repos.tables.db1.size).toBe(1);
    expect(r.ctx.req.masked_text_s3).toContain('30 to mihir');
  });

  it('an invalid answer re-asks with attempt + 1', async () => {
    const r = await run(typed, [first], [text('maybe'), chip('yes')]);
    expect(r.questions.map((x) => x.attempt)).toEqual([1, 2]);
  });

  it('numbers inside covered phrases, addresses and dates are not asked about', async () => {
    const r = await run('send 50 usdc to 0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E on 5 december', [first]);
    expect(r.result).toEqual({ kind: 'continue' });
  });
});

describe('S3 relative amounts (§8.4 step 6, C-097)', () => {
  const bal = (c: TestContext) =>
    seedBalances(c.repos, {
      11155111: { ETH: '1', USDC: '10' },
      84532: { ETH: '0.5', USDC: '80' },
      421614: { ETH: '0.3', USDC: '20' },
    });

  it('half my eth, no chain stated → the allowed chain with the largest spendable (gas reserve deducted), half rounded; pinned', async () => {
    const { ctx, result } = await run(
      'send half my eth to riya',
      [{ phrase: 'half my eth', number: null, relative: 'half', token: 'ETH' }],
      [],
      bal,
    );
    expect(result).toEqual({ kind: 'continue' });
    expect(ctx.req.amounts[0]).toMatchObject({
      amount: '0.495',
      token: 'ETH',
      relative: 'half',
      origin: 'relative',
      pinned_chain_id: 11155111,
      source: 'user',
      confirmed: true,
    });
    expect(ctx.repos.db1.get(ctx.req.amounts[0]!.placeholder)).toMatchObject({ origin: 'relative', amount: '0.495' });
  });

  it('all / max my usdc → full spendable', async () => {
    for (const rel of ['all', 'max'] as const) {
      const { ctx } = await run(
        'send all my usdc to riya',
        [{ phrase: 'all my usdc', number: null, relative: rel, token: 'USDC' }],
        [],
        bal,
      );
      expect(ctx.req.amounts[0]).toMatchObject({ amount: '80', pinned_chain_id: 84532, origin: 'relative' });
    }
  });

  it('a chain in the same clause pins the amount to that chain (clause beats prompt)', async () => {
    const { ctx } = await run(
      'send all my usdc to riya on arbitrum, then 1 usdc to a on base',
      [
        { phrase: 'all my usdc', number: null, relative: 'all', token: 'USDC' },
        { phrase: '1 usdc', number: '1', token: 'USDC' },
      ],
      [],
      bal,
    );
    expect(ctx.req.amounts[0]).toMatchObject({ amount: '20', pinned_chain_id: 421614 });
  });

  it('a single chain elsewhere in the prompt pins it; with two chains in the prompt and none in the clause the largest wins', async () => {
    const one = await run(
      'send half my usdc to riya, on arbitrum',
      [{ phrase: 'half my usdc', number: null, relative: 'half', token: 'USDC' }],
      [],
      bal,
    );
    expect(one.ctx.req.amounts[0]).toMatchObject({ amount: '10', pinned_chain_id: 421614 });
    const two = await run(
      'send half my usdc to riya, 1 usdc to a on base, 2 usdc to b on arbitrum',
      [
        { phrase: 'half my usdc', number: null, relative: 'half', token: 'USDC' },
        { phrase: '1 usdc', number: '1', token: 'USDC' },
        { phrase: '2 usdc', number: '2', token: 'USDC' },
      ],
      [],
      bal,
    );
    expect(two.ctx.req.amounts[0]).toMatchObject({ amount: '40', pinned_chain_id: 84532 });
  });

  it('half is rounded down in base units', async () => {
    const { ctx } = await run(
      'send half my usdc to riya',
      [{ phrase: 'half my usdc', number: null, relative: 'half', token: 'USDC' }],
      [],
      (c) => seedBalances(c.repos, { 11155111: { USDC: '0.000003' }, 84532: { USDC: '0' }, 421614: { USDC: '0' } }),
    );
    expect(ctx.req.amounts[0]?.amount).toBe('0.000001');
  });

  it('pending DB6 rows of the last 10 minutes are subtracted (§10.1)', async () => {
    const { ctx } = await run(
      'send all my usdc to riya on base',
      [{ phrase: 'all my usdc', number: null, relative: 'all', token: 'USDC' }],
      [],
      (c) => {
        bal(c);
        c.repos.db6.insertMany([
          {
            request_id: 'req_000000000009',
            session_id: c.req.session_id,
            step: 1,
            kind: 'payment',
            chain_id: 84532,
            token: 'USDC',
            amount: '30',
            status: 'pending',
            counts_toward_limit: true,
            created_at: '2026-11-05T17:25:00.000Z',
            executed_at: null,
            tx_hash: null,
          } as never,
        ]);
      },
    );
    expect(ctx.req.amounts[0]?.amount).toBe('50');
  });

  it('SQB-11 / F-10: value 0 → INSUFFICIENT_FUNDS with the zero chain dropped; text has no "across"', async () => {
    const { result } = await run(
      'send all my eth to riya on base',
      [{ phrase: 'all my eth', number: null, relative: 'all', token: 'ETH' }],
      [],
      (c) => seedBalances(c.repos, { 11155111: { ETH: '1' }, 84532: { ETH: '0.001' }, 421614: { ETH: '1' } }),
    );
    expect(result).toEqual({
      kind: 'error',
      code: 'INSUFFICIENT_FUNDS',
      params: { token: 'ETH', need: '0', have: '0', chains: '' },
    });
    if (result.kind !== 'error') throw new Error('expected error');
    const msg = ERROR_MESSAGE.INSUFFICIENT_FUNDS(result.params ?? {});
    expect(msg).toContain("You don't have enough ETH: you need 0, and can use 0.");
    expect(msg).not.toContain('across');
  });

  it('a pinned chain outside the allowlist → CHAIN_NOT_ALLOWED (SQB-20)', async () => {
    const { result } = await run(
      'send all my usdc to riya on arbitrum',
      [{ phrase: 'all my usdc', number: null, relative: 'all', token: 'USDC' }],
      [],
      (c) => {
        bal(c);
        c.limits.allowed_chain_ids = [11155111, 84532];
      },
    );
    expect(result).toEqual({ kind: 'error', code: 'CHAIN_NOT_ALLOWED', params: { chain: 'Arbitrum Sepolia' } });
  });

  it('every candidate chain unavailable → BALANCES_UNAVAILABLE', async () => {
    const { result } = await run(
      'send half my usdc to riya',
      [{ phrase: 'half my usdc', number: null, relative: 'half', token: 'USDC' }],
      [],
      (c) => {
        for (const id of [11155111, 84532, 421614] as const)
          c.repos.db4.markUnavailable(id, 'x', '2026-11-05T17:30:00Z');
      },
    );
    expect(result).toMatchObject({ kind: 'error', code: 'BALANCES_UNAVAILABLE' });
  });

  it('a relative amount without a token → Q_TOKEN (asked with the phrase), then resolves', async () => {
    const r = await run(
      'send half of everything to riya',
      [{ phrase: 'half of everything', number: null, relative: 'half' }],
      [chip('USDC')],
      bal,
    );
    expect(r.questions[0]).toMatchObject({ code: 'Q_TOKEN', text: 'Is half of everything in USDC or ETH?' });
    expect(r.ctx.req.amounts[0]).toMatchObject({ amount: '40', token: 'USDC', relative: 'half' });
  });
});

describe('S3 SQB-20 / SQB-22', () => {
  it('SQB-20: a relative amount pinned to a chain whose balance is unavailable → BALANCES_UNAVAILABLE naming that chain', async () => {
    const { result } = await run(
      'send all my usdc to riya on base',
      [{ phrase: 'all my usdc', number: null, relative: 'all', token: 'USDC' }],
      [],
      (c) => {
        seedBalances(c.repos, { 11155111: { USDC: '5' }, 421614: { USDC: '5' } });
        c.repos.db4.markUnavailable(84532, 'Base Sepolia', '2026-11-05T17:30:00Z');
      },
    );
    expect(result).toEqual({ kind: 'error', code: 'BALANCES_UNAVAILABLE', params: { chains: 'Base Sepolia' } });
  });

  it('SQB-22: a non-USD fiat word as the clause token word (phrase has none) → Q_FIAT_OTHER', async () => {
    const r = await run('pay riya 500 in rupees', [{ phrase: '500', number: '500' }]);
    expect(q(r)?.code).toBe('Q_FIAT_OTHER');
  });
});

describe('S3 rule 7 document amounts (C-098, C-313, C-398, C-299, C-397)', () => {
  const doc = (amount: string | null, token: 'USDC' | 'ETH' | null): QItem => ({
    item_index: 0,
    address: null,
    ens_name: null,
    amount,
    token,
  });

  async function docRun(typed: string, amounts: A[], untrusted: QItem[], answers: Parameters<typeof drive>[2] = []) {
    const ctx = await scannedCtx(typed, { fixture: fx(llm(typed, ...amounts)), req: { untrusted } });
    const d = await drive(s3, ctx, answers);
    return { ctx, ...d };
  }

  it('no typed pay amounts → Q_UNTRUSTED_AMOUNT; the row is minted source=untrusted/origin=document/confirmed=0 until "Use this amount"', async () => {
    const typed = 'pay the invoice please';
    const ctx = await scannedCtx(typed, { fixture: fx(llm(typed)), req: { untrusted: [doc('25', 'USDC')] } });
    const first = await s3.step(ctx);
    expect(first.kind).toBe('question');
    if (first.kind !== 'question') return;
    expect(first.question).toMatchObject({
      code: 'Q_UNTRUSTED_AMOUNT',
      text: 'The attached content says 25 USDC. Use this amount?',
    });
    expect(first.question.chips.map((c) => c.id)).toEqual(['use_amount', 'type_amount']);
    const rows = [...ctx.repos.tables.db1.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount: '25',
      token: 'USDC',
      source: 'untrusted',
      origin: 'document',
      confirmed: false,
    });
    const next = await s3.onAnswer!(ctx, first.question, chip('use_amount'));
    expect(next).toEqual({ kind: 'continue' });
    expect([...ctx.repos.tables.db1.values()][0]?.confirmed).toBe(true);
    expect(await s3.step(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.req.amounts[0]).toMatchObject({
      source: 'untrusted',
      origin: 'document',
      confirmed: true,
      untrusted_item_index: 0,
      amount: '25',
    });
  });

  it('"Type a different amount" → number question; the typed value becomes source=user, confirmed=1', async () => {
    const r = await docRun('pay the invoice please', [], [doc('25', 'USDC')], [chip('type_amount'), text('30')]);
    expect(r.questions.map((x) => x.code)).toEqual(['Q_UNTRUSTED_AMOUNT', 'Q_AMOUNT_MISSING']);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(r.ctx.req.amounts[0]).toMatchObject({ amount: '30', source: 'user', confirmed: true });
    expect([...r.ctx.repos.tables.db1.values()][0]).toMatchObject({ amount: '30', source: 'user', confirmed: true });
  });

  it('a document amount without a token → Q_TOKEN first', async () => {
    const r = await docRun('pay the invoice please', [], [doc('25', null)], [chip('ETH'), chip('use_amount')]);
    expect(r.questions.map((x) => x.code)).toEqual(['Q_TOKEN', 'Q_UNTRUSTED_AMOUNT']);
    expect(r.ctx.req.amounts[0]).toMatchObject({ token: 'ETH', amount: '25' });
  });

  it('every document amount needs its own Q_UNTRUSTED_AMOUNT', async () => {
    const r = await docRun(
      'pay the invoices please',
      [],
      [doc('1', 'USDC'), doc('2', 'USDC')],
      [chip('use_amount'), chip('use_amount')],
    );
    expect(r.questions.map((x) => x.code)).toEqual(['Q_UNTRUSTED_AMOUNT', 'Q_UNTRUSTED_AMOUNT']);
    expect(r.ctx.req.amounts.map((a) => a.amount)).toEqual(['1', '2']);
  });

  it('typed pay amounts present → document amounts are not used; note emitted once; no extra rows', async () => {
    const r = await docRun(
      'send 5 usdc to riya',
      [{ phrase: '5 usdc', number: '5', token: 'USDC' }],
      [doc('25', 'USDC')],
    );
    expect(r.result).toEqual({ kind: 'continue' });
    expect(r.ctx.req.amounts).toHaveLength(1);
    expect(r.ctx.req.notes).toEqual(["Amounts in the attached content weren't used."]);
    expect(r.ctx.repos.tables.db1.size).toBe(1);
  });

  it('documents without amounts (payee only) change nothing', async () => {
    const r = await docRun(
      'pay the invoice please',
      [],
      [{ item_index: 0, address: null, ens_name: 'riya.eth', amount: null, token: null }],
    );
    expect(r.result).toEqual({ kind: 'continue' });
    expect(r.ctx.req.amounts).toEqual([]);
  });

  it('SQB-18: a document amount of 0 → Q_AMOUNT_MISSING; more decimals than the token → Q_AMOUNT_PRECISION', async () => {
    const z = await docRun('pay the invoice please', [], [doc('0', 'USDC')]);
    expect(z.questions[0]?.code).toBe('Q_AMOUNT_MISSING');
    const p = await docRun('pay the invoice please', [], [doc('0.0000001', 'USDC')]);
    expect(p.questions[0]?.code).toBe('Q_AMOUNT_PRECISION');
  });

  it('C-399 (S3 side): no untrusted value ever appears in the LLM #1 prompt', async () => {
    const r = await docRun(
      'pay the invoice please',
      [],
      [
        doc('7777.5', 'USDC'),
        {
          item_index: 0,
          address: '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E',
          ens_name: 'evil.eth',
          amount: null,
          token: null,
        },
      ],
    );
    const all = r.ctx.llm.recorded.map((c) => c.system + c.user).join('\n');
    expect(all).not.toContain('7777.5');
    expect(all).not.toContain('evil.eth');
  });
});

describe('S3 re-entrancy and misuse', () => {
  it('step() after completion continues without a second LLM call', async () => {
    const { ctx } = await run('send 5 usdc to riya', [{ phrase: '5 usdc', number: '5', token: 'USDC' }]);
    expect(await s3.step(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.llm.recorded).toHaveLength(1);
    expect(ctx.repos.tables.db1.size).toBe(1);
  });

  it('QUESTION_TEXT/catalog wording is used for every S3 question', () => {
    expect(QUESTION_TEXT.Q_AMOUNT_UNCOVERED({ n: '30' })).toBe('Should 30 be paid?');
  });
});
