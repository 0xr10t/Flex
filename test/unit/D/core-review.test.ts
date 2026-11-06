// Independent regressions for the phase6 planning, pairing and hand-off fixes.
import { describe, expect, it } from 'vitest';
import { s8 } from '../../../src/pipeline/s8-pair.js';
import { s10 } from '../../../src/pipeline/s10-validate.js';
import { s12 } from '../../../src/pipeline/s12-handoff.js';
import { rejectMessage } from '../../../src/handoff/execution-client.js';
import { pairsToConfirm, retryableProblems } from '../../../src/plan/pairing-checks.js';
import { FixtureLlmClient } from '../../fakes/llm.js';
import { seedContact } from '../../fakes/repos.js';
import {
  ARB,
  BASE,
  RIYA_CS,
  SEPOLIA,
  addAmount,
  addAradhya,
  addMihir,
  addRecipient,
  addWord,
  ctxD,
  db6Row,
  expectError,
  expectQuestion,
  llmItem,
  pay,
  paymentsCall,
  planI,
  planJ,
  setClauses,
} from './helpers.js';
import { amountOf, asI, asJ, asK, chip, iPay, kSetup, run, runOk, text, usdc } from './s9-helpers.js';

describe('R4-F1 / R1-F2 pairing consent and independent attempts', () => {
  function setup() {
    const ctx = ctxD();
    setClauses(ctx, ['send 10 usdc', 'and 20 usdc to mihir', 'and aradhya']);
    const a1 = addAmount(ctx, '10', { clause: 0 });
    const a2 = addAmount(ctx, '20', { clause: 1 });
    const r1 = addMihir(ctx, 1);
    const r2 = addAradhya(ctx, 2);
    ctx.req.masked_text_s8 = `send ${a1} and ${a2} to ${r1} and ${r2}`;
    const llm = new FixtureLlmClient({
      calls: [paymentsCall(a1, [llmItem('i', a1, r2), llmItem('i', a2, r1)])],
    });
    ctx.llm = llm;
    return { ctx, llm, a1, a2, r1, r2 };
  }

  it('R4-F1 confirms every amount, including the one beside its proposed recipient, and permits a swap', async () => {
    const { ctx, llm, a1, a2, r1, r2 } = setup();
    const first = expectQuestion(await s8.step(ctx), 'Q_PAIR_AMOUNT');
    expect(first.text).toBe('Who should get 10 USDC?');
    expect(await s8.onAnswer?.(ctx, first, chip(r1))).toEqual({ kind: 'continue' });
    const second = expectQuestion(await s8.step(ctx), 'Q_PAIR_AMOUNT');
    expect(second.text).toBe('Who should get 20 USDC?');
    expect(await s8.onAnswer?.(ctx, second, chip(r2))).toEqual({ kind: 'continue' });
    expect(await s8.step(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.req.payments?.map((p) => [p.amount, p.recipient])).toEqual([
      [a1, r1],
      [a2, r2],
    ]);
    expect(llm.recorded).toHaveLength(1);
  });

  it('R1-F2 three invalid answers to the first amount leave three fresh retries for the second', async () => {
    const { ctx, r1, r2 } = setup();
    let q = expectQuestion(await s8.step(ctx), 'Q_PAIR_AMOUNT');
    for (const attempt of [2, 3, 4]) {
      const r = await s8.onAnswer?.(ctx, q, text('not a recipient'));
      if (!r) throw new Error('missing answer handler');
      q = expectQuestion(r, 'Q_PAIR_AMOUNT');
      expect(q.attempt).toBe(attempt);
    }
    expect(await s8.onAnswer?.(ctx, q, chip(r1))).toEqual({ kind: 'continue' });
    q = expectQuestion(await s8.step(ctx), 'Q_PAIR_AMOUNT');
    expect(q).toMatchObject({ text: 'Who should get 20 USDC?', attempt: 1 });
    for (const attempt of [2, 3, 4]) {
      const r = await s8.onAnswer?.(ctx, q, text('still not a recipient'));
      if (!r) throw new Error('missing answer handler');
      q = expectQuestion(r, 'Q_PAIR_AMOUNT');
      expect(q.attempt).toBe(attempt);
    }
    expect(await s8.onAnswer?.(ctx, q, chip(r2))).toEqual({ kind: 'continue' });
    expect(await s8.step(ctx)).toEqual({ kind: 'continue' });
  });

  it('R1-F2 unpaid-recipient rounds still stop after the fourth complete invalid choice set', async () => {
    const { ctx, r1 } = setup();
    for (let round = 1; round <= 4; round++) {
      const q1 = expectQuestion(await s8.step(ctx), 'Q_PAIR_AMOUNT');
      expect(q1.attempt).toBe(1);
      if (round > 1) expect(q1.text).toContain('That would leave Aradhya with nothing.');
      await s8.onAnswer?.(ctx, q1, chip(r1));
      const q2 = expectQuestion(await s8.step(ctx), 'Q_PAIR_AMOUNT');
      expect(q2.attempt).toBe(1);
      await s8.onAnswer?.(ctx, q2, chip(r1));
    }
    expectError(await s8.step(ctx), 'TOO_MANY_RETRIES');
    expect(ctx.req.payments).toBeUndefined();
  });
});

describe('SQ-R-02 distributive scope', () => {
  function setup() {
    const ctx = ctxD();
    setClauses(ctx, ['send 10 usdc each to mihir and aradhya', 'send 20 usdc to riya', 'send 30 usdc to mihir']);
    const a = addAmount(ctx, '10', { clause: 0 });
    const b = addAmount(ctx, '20', { clause: 1 });
    const c = addAmount(ctx, '30', { clause: 2 });
    const mihir = addMihir(ctx, 0);
    const aradhya = addAradhya(ctx, 0);
    const riya = addRecipient(ctx, { name: 'Riya', address: RIYA_CS, clause: 1 });
    const later = addMihir(ctx, 2);
    addWord(ctx, 'distributive', 'each');
    const pc = { amounts: [a, b, c], recipients: [mihir, aradhya, riya, later], chains: [] };
    const own = [pay(ctx, 'i', a, mihir), pay(ctx, 'i', a, aradhya)];
    return { ctx, pc, a, b, c, riya, later, own };
  }

  it('SQ-R-02 P2 allows local reuse but rejects reuse of another clause’s amount', () => {
    const { ctx, pc, b, c, riya, later, own } = setup();
    const valid = [...own, pay(ctx, 'i', b, riya), pay(ctx, 'i', c, later)];
    expect(retryableProblems(ctx, pc, valid)).toEqual([]);
    expect(retryableProblems(ctx, pc, [...valid, pay(ctx, 'i', b, later)])).toContain(
      `${b} is used more than once, but the user did not say "each".`,
    );
  });

  it('SQ-R-02 P4 still rejects swapped pairings in other clauses', () => {
    const { ctx, pc, b, c, riya, later, own } = setup();
    const problems = retryableProblems(ctx, pc, [...own, pay(ctx, 'i', b, later), pay(ctx, 'i', c, riya)]);
    expect(problems.some((p) => p.includes(`${b} is paired with ${later}`))).toBe(true);
  });

  it('SQ-R-02 Q_PAIR_AMOUNT still asks about other ambiguous amounts and excludes the each amount', () => {
    const { ctx, pc, b, c, riya, later, own } = setup();
    const payments = [...own, pay(ctx, 'i', b, later), pay(ctx, 'i', c, riya)];
    expect(pairsToConfirm(ctx, pc, payments)).toEqual([2, 3]);
  });
});

describe('R3-2 ENS chains and SQ-R-03 short autopay caps', () => {
  it.each([false, true])(
    'R3-2 an untrusted ENS payee stays on its record chain (saved during request: %s)',
    async (saved) => {
      const ctx = ctxD({ balances: usdc('100', '0', '0') });
      if (saved) seedContact(ctx.repos, 'Riya', RIYA_CS, [BASE, ARB]);
      const recipient = addRecipient(ctx, {
        name: null,
        address: RIYA_CS,
        ens_name: 'riya.eth',
        ens_chain_ids: [BASE],
        source: 'untrusted',
        untrusted_item_index: 0,
      });
      const plan = await runOk(ctx, [iPay(ctx, '10', recipient)]);
      expect(plan.map((p) => p.intent_id)).toEqual(['j', 'i']);
      expect(asJ(plan[0])).toMatchObject({ source_chain_id: SEPOLIA, dest_chain_id: BASE });
      expect(asI(plan[1])).toMatchObject({ chain_id: BASE, reused_from_chain_id: null });
      expect(ctx.req.notes).toEqual([]);
    },
  );

  it('R3-2 an explicit chain outside an untrusted ENS record is never used', async () => {
    const ctx = ctxD({ balances: usdc('100', '100', '100') });
    const recipient = addRecipient(ctx, {
      name: null,
      address: RIYA_CS,
      ens_name: 'riya.eth',
      ens_chain_ids: [BASE],
      source: 'untrusted',
      untrusted_item_index: 0,
    });
    expectError(await run(ctx, [iPay(ctx, '10', recipient, ARB)]), 'UNSUPPORTED_REQUEST');
    expect(ctx.req.plan).toBeUndefined();
  });

  it('SQ-R-03 daily 20 USDC for two payments caps both period and total at 40 without a needless override', async () => {
    const { ctx, payment } = kSetup({
      clause: 'pay mihir 20 usdc daily for 2 payments',
      amount: '20',
      frequency: 'daily',
      days_of_week: null,
    });
    const k = asK((await runOk(ctx, [payment]))[0]);
    expect(amountOf(ctx, k.limits.total_cap)).toBe('40');
    expect(amountOf(ctx, k.limits.per_period_cap)).toBe('40');
    expect(await s10.step(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.req.limit_override).toBe(false);
  });
});

describe('R4-F2 consent names limits; R4-F4 need includes bridge padding', () => {
  it('R4-F2 an autopay report during the override question requires consent to the newly broken daily limit', async () => {
    const ctx = ctxD({ balances: usdc('0', '1000', '0') });
    const amount = addAmount(ctx, '120');
    ctx.req.plan = [planI(0, amount, addMihir(ctx), BASE)];
    const before = structuredClone(ctx.repos.db5.getAll());
    const first = expectQuestion(await s10.step(ctx), 'Q_LIMIT_OVERRIDE');
    expect(first.text).toContain('per-payment limit of 100');
    expect(first.text).not.toContain("today's limit");
    ctx.repos.db6.insertMany([
      db6Row({ kind: 'autopay_payment', amount: '200', status: 'executed', executed_at: ctx.now().toUTC().toISO() }),
    ]);
    await s10.onAnswer?.(ctx, first, chip('override'));
    const second = expectQuestion(await s10.step(ctx), 'Q_LIMIT_OVERRIDE');
    expect(second.text).toContain("today's limit of 300 (only 100 is left)");
    expect(ctx.req.state).not.toBe('VALIDATED');
    await s10.onAnswer?.(ctx, second, chip('override'));
    expect(await s10.step(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.repos.db5.getAll()).toEqual(before);
  });

  it('R4-F4 S9 needs 102 when 100 must cross a chain and only 101 is available', async () => {
    const ctx = ctxD({ balances: usdc('0', '0', '101') });
    expectError(await run(ctx, [iPay(ctx, '100', addMihir(ctx), BASE)]), 'INSUFFICIENT_FUNDS', {
      token: 'USDC',
      need: '102',
      have: '101',
    });
  });

  it('R4-F4 S10 counts a planned bridge buffer exactly once after available funds fall', async () => {
    const ctx = ctxD({ balances: usdc('0', '0', '101') });
    const amount = addAmount(ctx, '100');
    ctx.req.plan = [
      planJ(ctx, 0, ARB, BASE, '102', '100', [1]),
      planI(1, amount, addMihir(ctx), BASE, { depends_on: [0] }),
    ];
    expectError(await s10.step(ctx), 'INSUFFICIENT_FUNDS', { token: 'USDC', need: '102', have: '101' });
  });

  it.each([
    { payment: '0.000003', sepolia: '0.000002', arbitrum: '0.000002', need: '0.000005', have: '0.000004' },
    { payment: '100', sepolia: '60', arbitrum: '42', need: '102.000001', have: '102' },
  ])('R4-F4 need includes each donor’s rounding buffer for a $payment USDC payment', async (row) => {
    const ctx = ctxD({ balances: usdc(row.sepolia, '0', row.arbitrum) });
    // Two separate rounded bridge amounts are required: 2+3 base units, or 60+42.000001 USDC.
    expectError(await run(ctx, [iPay(ctx, row.payment, addMihir(ctx), BASE)]), 'INSUFFICIENT_FUNDS', {
      token: 'USDC',
      need: row.need,
      have: row.have,
    });
  });

  it('R4-F4 two short chains are never used as donors when calculating padded need', async () => {
    const ctx = ctxD({ balances: usdc('10', '0', '0') });
    expectError(
      await run(ctx, [iPay(ctx, '20', addMihir(ctx), BASE), iPay(ctx, '30', addAradhya(ctx), ARB)]),
      'INSUFFICIENT_FUNDS',
      {
        token: 'USDC',
        need: '51',
        have: '10',
      },
    );
  });
});

describe('R5-1 accepted hand-off recording and R6-3 refusal text', () => {
  it('R1-F1 R5-2 S12 snapshots the autopay recipient before awaiting execution', async () => {
    const { ctx, payment } = kSetup({ clause: 'pay mihir 10 usdc every friday for 4 payments' });
    const k = asK((await runOk(ctx, [payment]))[0]);
    ctx.exec.submit = async () => {
      // Exercise the snapshot independently of the manager’s close-waits rule.
      ctx.repos.clearSessionStores();
      return { status: 'accepted' };
    };
    expect(await s12.step(ctx)).toEqual({ kind: 'answer', messages: ['Sent to your wallet for signing.'] });
    expect(ctx.repos.db7.get(k.autopay_id)?.recipient_name).toBe('Mihir');
    expect(ctx.req.state).toBe('HANDED_OFF');
  });

  it.each(['spend', 'history'] as const)(
    'R5-1 accepted execution remains HANDED_OFF if the %s write fails',
    async (failure) => {
      const ctx = ctxD();
      ctx.req.plan = [planI(0, addAmount(ctx, '10'), addMihir(ctx), BASE)];
      if (failure === 'spend')
        ctx.repos.db6.insertMany = () => {
          throw new Error('injected storage failure');
        };
      else
        ctx.repos.db8.appendHistory = () => {
          throw new Error('injected storage failure');
        };
      expect(await s12.step(ctx)).toEqual({ kind: 'answer', messages: ['Sent to your wallet for signing.'] });
      expect(ctx.req.state).toBe('HANDED_OFF');
      expect(ctx.exec.submissions).toHaveLength(1);
      expect(ctx.log.lines.filter((l) => l.rule_id === 'S12_RECORD_FAILED')).toHaveLength(1);
    },
  );

  it('R6-3 strips bidi, zero-width and line separators while preserving readable refusal text', () => {
    expect(rejectMessage('Denied\u202e\u202d\u200b\u200d\u2066\u2069\ufeff\u2028\u2029: retry')).toBe('Denied: retry');
    expect(Array.from(rejectMessage('🙂'.repeat(201)))).toHaveLength(200);
  });
});
