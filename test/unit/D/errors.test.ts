// Lane D tester: §15 error templates raised in their stated cases (S9), with the catalog message text asserted verbatim.
import { describe, expect, it, vi } from 'vitest';
import {
  ALICE_CS,
  ARB,
  BASE,
  BOB_CS,
  SEPOLIA,
  addAmount,
  addAradhya,
  addAutopay,
  addGroup,
  addMihir,
  ctxD,
  expectError,
  pay,
  setLimits,
} from './helpers.js';
import { buildSummary } from '../../../src/messages/summary.js';
import type { AddressPh, InternalIntent } from '../../../src/contracts/types.js';
import { iPay, kSetup, run, usdc } from './s9-helpers.js';

vi.mock('../../../src/amounts/parse.js', async () => {
  const m = await import('./parse-mock.js');
  return { parseAmountText: (t: string) => m.fakeParseAmountText(t) };
});

function lCtx(): { ctx: ReturnType<typeof ctxD>; payment: ReturnType<typeof pay> } {
  const ctx = ctxD({ actions: ['l'], balances: usdc('0', '10', '10') });
  const mi = addMihir(ctx);
  return { ctx, payment: pay(ctx, 'l', null, mi) };
}

describe('§15 error messages in their stated cases', () => {
  it('C-378 §15 NO_ACTIVE_AUTOPAY: "stop paying mihir" with no active autopay', async () => {
    const { ctx, payment } = lCtx();
    const msg = expectError(await run(ctx, [payment]), 'NO_ACTIVE_AUTOPAY', { name: 'Mihir' });
    expect(msg).toBe("There's no active repeating payment to Mihir.");
  });

  it('C-379 §15 AUTOPAY_NOT_READY: only a pending autopay exists', async () => {
    const { ctx, payment } = lCtx();
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7', status: 'pending' });
    const msg = expectError(await run(ctx, [payment]), 'AUTOPAY_NOT_READY');
    expect(msg).toBe('That repeating payment is still being set up. Try again shortly.');
  });

  it('C-380 §15 AUTOPAY_NO_OCCURRENCES: end date before the first occurrence', async () => {
    const { ctx, payment } = kSetup({
      clause: 'pay mihir 10 usdc every day until nov 5',
      frequency: 'daily',
      days_of_week: null,
      chrono: [{ kind: 'end', date: '2026-11-05' }],
    });
    const msg = expectError(await run(ctx, [payment]), 'AUTOPAY_NO_OCCURRENCES');
    expect(msg).toBe('That schedule has no payment dates. Check the start and end.');
  });

  it('C-381 §15 SQ-08 F-10 INSUFFICIENT_FUNDS: 50.6 USDC needed with padding, 30 usable across the chains with a positive amount', async () => {
    const ctx = ctxD({ balances: usdc('0', '10', '20') });
    const r = addAradhya(ctx);
    const msg = expectError(await run(ctx, [iPay(ctx, '50', r)]), 'INSUFFICIENT_FUNDS', {
      token: 'USDC',
      need: '50.6',
      have: '30',
    });
    expect(msg).toBe(
      "You don't have enough USDC: you need 50.6, and can use 30 across Base Sepolia (10) and Arbitrum Sepolia (20).",
    );
  });

  it('SQ-08 F-10 INSUFFICIENT_FUNDS with no usable chain reads "can use 0." without an "across" part', async () => {
    const ctx = ctxD({ balances: usdc('0', '0', '0') });
    const r = addAradhya(ctx);
    const msg = expectError(await run(ctx, [iPay(ctx, '50', r)]), 'INSUFFICIENT_FUNDS', { have: '0' });
    expect(msg).toBe("You don't have enough USDC: you need 51, and can use 0.");
  });

  it('SQ-08 F-10 INSUFFICIENT_FUNDS leaves an unreadable chain out of the list and the total', async () => {
    const ctx = ctxD({ balances: usdc('0', '10', '20') });
    ctx.repos.db4.markUnavailable(ARB, 'Arbitrum Sepolia', '2026-11-05T17:30:00.000Z');
    const r = addAradhya(ctx);
    const msg = expectError(await run(ctx, [iPay(ctx, '50', r)]), 'INSUFFICIENT_FUNDS', { have: '10' });
    expect(msg).toBe("You don't have enough USDC: you need 50.8, and can use 10 across Base Sepolia (10).");
  });

  it('C-382 §15 NO_GAS: a bridge source with ETH below the reserve', async () => {
    const ctx = ctxD({ balances: { ...usdc('0', '30', '60'), [ARB]: { USDC: '60', ETH: '0.001' } } });
    const r = addAradhya(ctx);
    const msg = expectError(await run(ctx, [iPay(ctx, '50', r, BASE)]), 'NO_GAS', {
      reserve: '0.002',
      chain: 'Arbitrum Sepolia',
    });
    expect(msg).toBe('You need at least 0.002 ETH on Arbitrum Sepolia for network fees.');
  });

  it('C-383 §15 CHAIN_NOT_ALLOWED: stated chain outside allowed_chain_ids', async () => {
    const ctx = ctxD({ balances: usdc('100', '100', '100') });
    setLimits(ctx, { allowed_chain_ids: [BASE, ARB] });
    const r = addMihir(ctx);
    const msg = expectError(await run(ctx, [iPay(ctx, '5', r, SEPOLIA)]), 'CHAIN_NOT_ALLOWED', { chain: 'Sepolia' });
    expect(msg).toBe("Sepolia isn't in your allowed chains (Settings).");
  });

  it('SQ-D-16 F-5 content amount: C-386 §15 LIMIT_AUTOPAY_PERIOD: daily 20 USDC = 140 a week over the limit of 100', async () => {
    const { ctx, payment } = kSetup({
      clause: 'pay mihir 20 usdc every day for 4 weeks',
      frequency: 'daily',
      days_of_week: null,
      amount: '20',
    });
    markContent(ctx);
    const msg = expectError(await run(ctx, [payment]), 'LIMIT_AUTOPAY_PERIOD', {
      cap: '140',
      token: 'USDC',
      max: '100',
    });
    expect(msg).toBe('This pays 140 USDC a week, over your autopay limit of 100 a week.');
  });

  it('SQ-D-16 F-5 content amount: C-387 §15 LIMIT_AUTOPAY_DURATION: "for 60 weeks" against 52', async () => {
    const { ctx, payment } = kSetup({ clause: 'pay mihir 10 usdc every friday for 60 weeks' });
    markContent(ctx);
    const msg = expectError(await run(ctx, [payment]), 'LIMIT_AUTOPAY_DURATION', { weeks: '52' });
    expect(msg).toBe('Repeating payments can run for at most 52 weeks.');
  });

  it('SQ-D-16 F-5 content amount: C-388 §15 LIMIT_BRIDGES: two bridges with a limit of one', async () => {
    const ctx = ctxD({ balances: usdc('100', '30', '30') });
    setLimits(ctx, { max_bridges_per_request: 1 });
    const a = addAradhya(ctx);
    const mi = addMihir(ctx);
    markContent(ctx);
    const msg = expectError(await run(ctx, [iPay(ctx, '40', a, BASE), iPay(ctx, '40', mi, ARB)]), 'LIMIT_BRIDGES', {
      n: '2',
      max: '1',
    });
    expect(msg).toBe('This needs 2 transfers between chains; your limit is 1.');
  });
});

describe('§13.1 group lines keyed on group and amount (S9 → S11)', () => {
  it('C-281 §13.1 two payments to the same group with different amounts → two group lines, members listed once each', async () => {
    const ctx = ctxD({ balances: usdc('0', '500', '0') });
    const { group } = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [
        { subname: 'alice.iitr.eth', address: ALICE_CS },
        { subname: 'bob.iitr.eth', address: BOB_CS },
      ],
    });
    const a10 = addAmount(ctx, '10');
    const a20 = addAmount(ctx, '20');
    const res = await run(ctx, [pay(ctx, 'i', a10, group, BASE), pay(ctx, 'i', a20, group, BASE)]);
    expect(res).toEqual({ kind: 'continue' });
    const plan = ctx.req.plan as InternalIntent[];
    expect(plan).toHaveLength(4);
    const s = buildSummary(ctx, plan);
    expect(s.lines).toEqual([
      '1. Send 10 USDC each to 2 members of iitr.eth on Base Sepolia: alice.iitr.eth, bob.iitr.eth.',
      '2. Send 20 USDC each to 2 members of iitr.eth on Base Sepolia: alice.iitr.eth, bob.iitr.eth.',
    ]);
    expect(s.footer).toEqual(['Spent today after this: 60 of 300 USDC.']);
  });

  it('C-281 §13.1 hand-built plan: same group, amounts 10 then 20, adjacent intents → separate lines', () => {
    const ctx = ctxD({ balances: usdc('0', '500', '0') });
    const { members } = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [
        { subname: 'alice.iitr.eth', address: ALICE_CS },
        { subname: 'bob.iitr.eth', address: BOB_CS },
      ],
    });
    const a10 = addAmount(ctx, '10');
    const a20 = addAmount(ctx, '20');
    const mk = (step: number, amount: typeof a10, who: string): InternalIntent => ({
      intent_id: 'i',
      step,
      depends_on: [],
      token: 'USDC',
      chain_id: BASE,
      amount,
      recipient: members[who] as AddressPh,
      reused_from_chain_id: null,
    });
    const s = buildSummary(ctx, [
      mk(0, a10, 'alice.iitr.eth'),
      mk(1, a10, 'bob.iitr.eth'),
      mk(2, a20, 'alice.iitr.eth'),
      mk(3, a20, 'bob.iitr.eth'),
    ]);
    expect(s.lines.map((l) => l.replace(/^\d+\. /, '').slice(0, 24))).toEqual([
      'Send 10 USDC each to 2 m',
      'Send 20 USDC each to 2 m',
    ]);
  });
});

/** SQ-D-16 F-5: an amount from attached content in the request keeps the limit errors at S9 (typed amounts are left to S10). */
function markContent(ctx: Parameters<typeof addAmount>[0]): void {
  addAmount(ctx, '1', { source: 'untrusted' });
}
