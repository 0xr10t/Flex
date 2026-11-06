// Lane D tester: §10.4 bridges (pure planBridges + S9 integration), §10.5 ordering, INSUFFICIENT_FUNDS, LIMIT_BRIDGES, NO_GAS.
import { describe, expect, it } from 'vitest';
import { planBridges } from '../../../src/plan/bridges.js';
import type { ChainId } from '../../../src/contracts/types.js';
import {
  ARB,
  BASE,
  SEPOLIA,
  addAmount,
  addAradhya,
  addMihir,
  ctxD,
  db6Row,
  expectError,
  setLimits,
} from './helpers.js';
import { PENDING_RECENT, amountOf, asI, asJ, db1Count, iPay, run, runOk, usdc } from './s9-helpers.js';

const ALLOWED: ChainId[] = [SEPOLIA, BASE, ARB];
const m = (e: Array<[ChainId, bigint]>): Map<ChainId, bigint> => new Map(e);

describe('planBridges (§10.4 math, base units)', () => {
  it('C-213 §10.4 E2: short 20 on Base, surplus 60 on Arbitrum → x = 20, padded = ceil(20 × 1.02) = 20.4', () => {
    const out = planBridges(
      'USDC',
      ALLOWED,
      m([
        [SEPOLIA, 0n],
        [BASE, 30_000_000n],
        [ARB, 60_000_000n],
      ]),
      m([
        [BASE, 50_000_000n],
        [SEPOLIA, 0n],
        [ARB, 0n],
      ]),
      '2',
    );
    expect(out).toEqual([{ token: 'USDC', source: ARB, dest: BASE, padded: 20_400_000n, deliverable: 20_000_000n }]);
  });

  it('C-213 §10.4 padded rounds UP at the base-unit level: short 7 units, b = 2 → ceil(7.14) = 8', () => {
    const out = planBridges('USDC', ALLOWED, m([[ARB, 100n]]), m([[BASE, 7n]]), '2');
    expect(out).toEqual([{ token: 'USDC', source: ARB, dest: BASE, padded: 8n, deliverable: 7n }]);
  });

  it('C-213 §10.4 deliverable rounds DOWN: surplus 10 units → floor(1000/102) = 9; x = min(remaining, 9), padded = ceil(9.18) = 10', () => {
    // short 9 (need 9, spendable 0) with surplus exactly 10 on the source
    const out = planBridges('USDC', ALLOWED, m([[ARB, 10n]]), m([[BASE, 9n]]), '2');
    expect(out).toEqual([{ token: 'USDC', source: ARB, dest: BASE, padded: 10n, deliverable: 9n }]);
  });

  it('C-213 C-214 §10.4 short larger than what the only source can deliver after padding → INSUFFICIENT_FUNDS (null)', () => {
    // surplus 10 → deliverable 9, short 10 → remaining 1 and no surplus left
    expect(planBridges('USDC', ALLOWED, m([[ARB, 10n]]), m([[BASE, 10n]]), '2')).toBeNull();
  });

  it('C-213 C-214 §10.4 no chain with surplus → INSUFFICIENT_FUNDS (null)', () => {
    expect(planBridges('USDC', ALLOWED, m([[ARB, 0n]]), m([[BASE, 5n]]), '2')).toBeNull();
  });

  it('C-213 C-214 §10.4 x == 0 (surplus 1 unit → deliverable floor(100/102) = 0) → INSUFFICIENT_FUNDS (null)', () => {
    expect(planBridges('USDC', ALLOWED, m([[ARB, 1n]]), m([[BASE, 1n]]), '2')).toBeNull();
  });

  it('C-213 §10.4 multiple sources: the largest surplus is used first, then the next for the remainder', () => {
    // Base short 100 USDC; Sepolia surplus 60 and Arbitrum surplus 60 (tie → allowed order: Sepolia first)
    const out = planBridges(
      'USDC',
      ALLOWED,
      m([
        [SEPOLIA, 60_000_000n],
        [ARB, 60_000_000n],
      ]),
      m([[BASE, 100_000_000n]]),
      '2',
    );
    expect(out).toEqual([
      { token: 'USDC', source: SEPOLIA, dest: BASE, padded: 60_000_000n, deliverable: 58_823_529n },
      { token: 'USDC', source: ARB, dest: BASE, padded: 42_000_001n, deliverable: 41_176_471n },
    ]);
  });

  it('C-213 §10.4 multiple shortfalls are served by short desc, then allowed order', () => {
    const out = planBridges(
      'USDC',
      ALLOWED,
      m([[SEPOLIA, 1_000_000_000n]]),
      m([
        [BASE, 10_000_000n],
        [ARB, 30_000_000n],
      ]),
      '2',
    );
    expect(out?.map((b) => b.dest)).toEqual([ARB, BASE]);
    // equal shortfalls → allowed order (Base before Arbitrum)
    const tie = planBridges(
      'USDC',
      ALLOWED,
      m([[SEPOLIA, 1_000_000_000n]]),
      m([
        [ARB, 10_000_000n],
        [BASE, 10_000_000n],
      ]),
      '2',
    );
    expect(tie?.map((b) => b.dest)).toEqual([BASE, ARB]);
  });

  it('C-213 §10.4 non-integer buffer pct 2.5: deliverable = floor(surplus × 100 / 102.5), padded = ceil(x × 1.025)', () => {
    const out = planBridges('USDC', ALLOWED, m([[ARB, 1_000_000n]]), m([[BASE, 500_000n]]), '2.5');
    expect(out).toEqual([{ token: 'USDC', source: ARB, dest: BASE, padded: 512_500n, deliverable: 500_000n }]);
    // deliverable is capped by the source: surplus 1_000_000 → floor(975609.7) = 975609, padded = ceil(999999.225)
    const capped = planBridges('USDC', ALLOWED, m([[ARB, 1_000_000n]]), m([[BASE, 2_000_000n]]), '2.5');
    expect(capped).toBeNull(); // second round: nothing left
    const exact = planBridges('USDC', ALLOWED, m([[ARB, 1_000_000n]]), m([[BASE, 975_609n]]), '2.5');
    expect(exact?.[0]).toMatchObject({ deliverable: 975_609n, padded: 1_000_000n });
  });

  it('C-213 §10.4 the source surplus shrinks by the padded amount between bridges to the same source', () => {
    // Two destinations short 10 each from one source with surplus 25: first padded 10.2, second x ≤ floor(14.8×100/102)
    const out = planBridges(
      'USDC',
      ALLOWED,
      m([[SEPOLIA, 25_000_000n]]),
      m([
        [BASE, 10_000_000n],
        [ARB, 10_000_000n],
      ]),
      '2',
    );
    expect(out).toEqual([
      { token: 'USDC', source: SEPOLIA, dest: BASE, padded: 10_200_000n, deliverable: 10_000_000n },
      { token: 'USDC', source: SEPOLIA, dest: ARB, padded: 10_200_000n, deliverable: 10_000_000n },
    ]);
  });
});

describe('S9 bridges end to end (§10.4, §10.5)', () => {
  it('C-213 C-216 §10.4 DB1 mint: padded amount source derived, origin bridge_padded, confirmed; deliverable_base_units = x', async () => {
    const ctx = ctxD({ balances: usdc('0', '30', '60') });
    const r = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '50', r, BASE)]);
    const j = asJ(plan[0]);
    expect(amountOf(ctx, j.amount)).toBe('20.4');
    expect(ctx.repos.db1.get(j.amount)).toMatchObject({
      source: 'derived',
      origin: 'bridge_padded',
      confirmed: true,
      token: 'USDC',
    });
    expect(j.deliverable_base_units).toBe('20000000');
    expect(j).toMatchObject({ source_chain_id: ARB, dest_chain_id: BASE, receiver: 'self', funds_steps: [1] });
  });

  it('C-213 §10.4 buffer pct 2.5 from DB5 is honoured: 20 short → padded 20.5', async () => {
    const ctx = ctxD({ balances: usdc('0', '30', '60') });
    setLimits(ctx, { bridge_buffer_pct: '2.5' });
    const r = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '50', r, BASE)]);
    expect(amountOf(ctx, asJ(plan[0]).amount)).toBe('20.5');
  });

  it('C-213 §10.4 padded with a rounding case: short 0.333333 → padded ceil(339999.66) = 0.34', async () => {
    const ctx = ctxD({ balances: usdc('0', '9.666667', '60') });
    const r = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '10', r, BASE)]);
    const j = asJ(plan[0]);
    expect(j.deliverable_base_units).toBe('333333');
    expect(amountOf(ctx, j.amount)).toBe('0.34');
  });

  it('C-214 §10.4 SQ-08 INSUFFICIENT_FUNDS params: token, need, have (sum of spendable on ok chains), chains', async () => {
    const ctx = ctxD({ balances: usdc('0', '10', '20') });
    const r = addAradhya(ctx);
    const res = await run(ctx, [iPay(ctx, '50', r)]);
    expectError(res, 'INSUFFICIENT_FUNDS', { token: 'USDC', need: '50.6', have: '30' });
    if (res.kind === 'error') expect(res.params?.chains).toContain('Base Sepolia');
    expect(ctx.req.plan).toBeUndefined();
  });

  it('C-214 §10.4 funds equal to the need but not enough for the 2% padding → INSUFFICIENT_FUNDS', async () => {
    // E6 shape: need 80, Base 30 + Arbitrum 50 = 80 spendable, but the bridge needs 30 / 1.02 deliverable only
    const ctx = ctxD({ balances: usdc('0', '30', '50') });
    const r = addAradhya(ctx);
    expectError(await run(ctx, [iPay(ctx, '80', r)]), 'INSUFFICIENT_FUNDS', { need: '80.6', have: '80' });
  });

  it('C-214 §10.1 §10.4 pending spend reduces what counts as have (floored at 0 per chain)', async () => {
    const ctx = ctxD({ balances: usdc('0', '10', '20') });
    ctx.repos.db6.insertMany([db6Row({ kind: 'payment', amount: '30', created_at: PENDING_RECENT })]);
    const r = addAradhya(ctx);
    const res = await run(ctx, [iPay(ctx, '50', r)]);
    expectError(res, 'INSUFFICIENT_FUNDS', { need: '50.6', have: '20' });
  });

  it('SQ-D-16 F-5 content amount: C-215 §10.4 more j intents than max_bridges_per_request → LIMIT_BRIDGES {n, max}', async () => {
    const ctx = ctxD({ balances: usdc('100', '30', '30') });
    setLimits(ctx, { max_bridges_per_request: 1 });
    const a = addAradhya(ctx);
    const mi = addMihir(ctx);
    markContent(ctx);
    const res = await run(ctx, [iPay(ctx, '40', a, BASE), iPay(ctx, '40', mi, ARB)]);
    expectError(res, 'LIMIT_BRIDGES', { n: '2', max: '1' });
  });

  it('C-215 §10.4 exactly max_bridges_per_request j intents is allowed', async () => {
    const ctx = ctxD({ balances: usdc('100', '30', '30') });
    setLimits(ctx, { max_bridges_per_request: 2 });
    const a = addAradhya(ctx);
    const mi = addMihir(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '40', a, BASE), iPay(ctx, '40', mi, ARB)]);
    expect(plan.filter((p) => p.intent_id === 'j')).toHaveLength(2);
  });

  it('C-217 §10.4 NO_GAS for a j source whose raw ETH is below eth_gas_reserve', async () => {
    const ctx = ctxD({ balances: { ...usdc('0', '30', '60'), [ARB]: { USDC: '60', ETH: '0.001' } } });
    const r = addAradhya(ctx);
    expectError(await run(ctx, [iPay(ctx, '50', r, BASE)]), 'NO_GAS', { reserve: '0.002', chain: 'Arbitrum Sepolia' });
  });

  it('C-217 §10.4 NO_GAS for the chain of an i intent', async () => {
    const ctx = ctxD({ balances: { [BASE]: { USDC: '80', ETH: '0.001' } } });
    const r = addAradhya(ctx);
    expectError(await run(ctx, [iPay(ctx, '5', r, BASE)]), 'NO_GAS', { reserve: '0.002', chain: 'Base Sepolia' });
  });

  it('C-217 §10.4 SQ-16 pending ETH counts: raw 0.1 − pending 0.099 = 0.001 < reserve 0.002 → NO_GAS', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    ctx.repos.db6.insertMany([db6Row({ kind: 'payment', amount: '0.099', token: 'ETH', created_at: PENDING_RECENT })]);
    const r = addAradhya(ctx);
    expectError(await run(ctx, [iPay(ctx, '5', r, BASE)]), 'NO_GAS', { chain: 'Base Sepolia' });
  });

  it('C-217 §10.4 raw ETH exactly equal to the reserve passes (≥)', async () => {
    const ctx = ctxD({ balances: { [BASE]: { USDC: '80', ETH: '0.002' } } });
    const r = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '5', r, BASE)]);
    expect(asI(plan[0]).chain_id).toBe(BASE);
  });

  it('C-217 §10.4 a chain the plan does not touch needs no gas', async () => {
    const ctx = ctxD({ balances: { [SEPOLIA]: { ETH: '0' }, [BASE]: { USDC: '80' } } });
    const r = addAradhya(ctx);
    await runOk(ctx, [iPay(ctx, '5', r, BASE)]);
  });

  it('C-219 C-221 C-222 §10.5 two destinations: j ordered by the first payment needing the destination, not by short size', async () => {
    const ctx = ctxD({ balances: usdc('200', '10', '10') });
    const mi = addMihir(ctx);
    const a = addAradhya(ctx);
    // P0 → Arbitrum (short 30), P1 → Base (short 35): bridging by short desc would put Base first
    const plan = await runOk(ctx, [iPay(ctx, '40', mi, ARB), iPay(ctx, '45', a, BASE)]);
    expect(plan.map((p) => p.intent_id)).toEqual(['j', 'j', 'i', 'i']);
    expect(asJ(plan[0])).toMatchObject({ source_chain_id: SEPOLIA, dest_chain_id: ARB, funds_steps: [2] });
    expect(asJ(plan[1])).toMatchObject({ source_chain_id: SEPOLIA, dest_chain_id: BASE, funds_steps: [3] });
    expect(asI(plan[2])).toMatchObject({ depends_on: [0], chain_id: ARB });
    expect(asI(plan[3])).toMatchObject({ depends_on: [1], chain_id: BASE });
  });

  it('C-219 C-221 C-222 §10.5 several sources for one destination: j in source allowed order; the i depends on all of them', async () => {
    const ctx = ctxD({ balances: usdc('60', '0', '60') });
    const a = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '100', a, BASE)]);
    expect(plan.map((p) => p.intent_id)).toEqual(['j', 'j', 'i']);
    expect(asJ(plan[0])).toMatchObject({ source_chain_id: SEPOLIA, dest_chain_id: BASE, funds_steps: [2] });
    expect(asJ(plan[1])).toMatchObject({ source_chain_id: ARB, dest_chain_id: BASE, funds_steps: [2] });
    expect(amountOf(ctx, asJ(plan[0]).amount)).toBe('60');
    expect(amountOf(ctx, asJ(plan[1]).amount)).toBe('42.000001');
    expect(asI(plan[2]).depends_on).toEqual([0, 1]);
  });

  it('C-221 §10.5 depends_on matches destination chain AND token: an ETH payment is not funded by a USDC bridge', async () => {
    const ctx = ctxD({ balances: { [BASE]: { USDC: '10' }, [ARB]: { USDC: '60' } } });
    const a = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '30', a, BASE), iPay(ctx, '0.01', a, BASE, { token: 'ETH' })]);
    const [j, usdcI, ethI] = plan;
    expect(asJ(j).funds_steps).toEqual([1]);
    expect(asI(usdcI).depends_on).toEqual([0]);
    expect(asI(ethI).token).toBe('ETH');
    expect(asI(ethI).depends_on).toEqual([]);
  });

  it('C-211 C-213 §10.3 rule 5 + §10.4: contact, nothing ≥ need anywhere → target the largest spendable (extended set), bridge the shortfall', async () => {
    // Aradhya chains Base/Arb; need 50. Base 30, Arb 45, Sepolia 49 → target Sepolia (extended), reused from Base
    const ctx = ctxD({ balances: usdc('49', '30', '45') });
    const a = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '50', a)]);
    expect(asJ(plan[0])).toMatchObject({ source_chain_id: ARB, dest_chain_id: SEPOLIA });
    expect(amountOf(ctx, asJ(plan[0]).amount)).toBe('1.02');
    expect(asI(plan[1])).toMatchObject({ chain_id: SEPOLIA, depends_on: [0] });
  });

  it('C-211 §10.3 rule 5: a bridge never uses the destination as its own source', async () => {
    const ctx = ctxD({ balances: usdc('0', '45', '0') });
    const a = addAradhya(ctx);
    expectError(await run(ctx, [iPay(ctx, '50', a)]), 'INSUFFICIENT_FUNDS', { need: '50.1', have: '45' });
  });

  it('C-213 §10.2 no DB1 mint happens when the request fails on a bridge check', async () => {
    const ctx = ctxD({ balances: usdc('0', '10', '20') });
    const a = addAradhya(ctx);
    const payment = iPay(ctx, '50', a);
    const before = db1Count(ctx);
    await run(ctx, [payment]);
    expect(db1Count(ctx)).toBe(before);
  });
});

/** SQ-D-16 F-5: an amount from attached content in the request keeps the limit errors at S9 (typed amounts are left to S10). */
function markContent(ctx: Parameters<typeof addAmount>[0]): void {
  addAmount(ctx, '1', { source: 'untrusted' });
}

describe('SQ-D-16 F-4 typed amounts: S9 lets the bridge count through (S10 asks)', () => {
  it('SQ-D-16 F-4 S9 more j intents than max_bridges_per_request pass S9 for typed amounts', async () => {
    const ctx = ctxD({ balances: usdc('100', '30', '30') });
    setLimits(ctx, { max_bridges_per_request: 1 });
    const a = addAradhya(ctx);
    const mi = addMihir(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '40', a, BASE), iPay(ctx, '40', mi, ARB)]);
    expect(plan.filter((p) => p.intent_id === 'j')).toHaveLength(2);
  });
});
