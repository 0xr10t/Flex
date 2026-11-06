// Tests: §8.1 S0 refresh balances — C-051 (parallel ETH + USDC per allowed chain), C-052 (bigint → decimal
// strings, ETH 18 / USDC 6), C-053 (DB4 upsert ok), C-054 (failure → both rows unavailable, old values kept, note),
// C-055 (all unavailable → BALANCES_UNAVAILABLE), C-056 (no AnswerHandler: S0 runs only for new messages),
// C-294 (note wording), C-364 (BALANCES_UNAVAILABLE catalog message), §18 log labels.
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE } from '../../../src/contracts/catalog.js';
import { s0 } from '../../../src/pipeline/s0-balances.js';
import { makeTestContext } from '../../fakes/context.js';
import { seedBalances } from '../../fakes/repos.js';
import { expectLabelsOk } from './helpers.js';

const SEP = 11155111;
const BASE = 84532;
const ARB = 421614;

describe('S0 balances (§8.1)', () => {
  it('§8.1 steps 1-3 (C-051, C-052, C-053): queries ETH and USDC on every allowed chain, stores decimal strings', async () => {
    const ctx = makeTestContext();
    ctx.rpc.eth.set(SEP, 1_500_000_000_000_000_000n);
    ctx.rpc.usdc.set(SEP, 80_000_000n);
    ctx.rpc.eth.set(BASE, 1n);
    ctx.rpc.usdc.set(BASE, 1n);
    ctx.rpc.usdc.set(ARB, 123_456_789n);
    const r = await s0.step(ctx);
    expect(r).toEqual({ kind: 'continue' });
    expect(ctx.rpc.calls).toHaveLength(6);
    expect(new Set(ctx.rpc.calls.map((c) => `${c.fn}:${c.chain_id}`)).size).toBe(6);
    const eth = ctx.repos.db4.get(SEP, 'ETH');
    expect(eth).toMatchObject({ balance: '1.5', base_units: '1500000000000000000', status: 'ok', token: 'ETH' });
    expect(ctx.repos.db4.get(SEP, 'USDC')).toMatchObject({ balance: '80', base_units: '80000000', status: 'ok' });
    expect(ctx.repos.db4.get(BASE, 'ETH')?.balance).toBe('0.000000000000000001');
    expect(ctx.repos.db4.get(BASE, 'USDC')?.balance).toBe('0.000001');
    expect(ctx.repos.db4.get(ARB, 'USDC')?.balance).toBe('123.456789');
    expect(typeof ctx.repos.db4.get(ARB, 'USDC')?.balance).toBe('string');
    expect(ctx.repos.db4.get(SEP, 'ETH')?.updated_at).toBe('2026-11-05T17:30:00.000Z');
    expect(ctx.req.notes).toEqual([]);
    expect(ctx.req.state).toBe('BALANCES_REFRESHED');
    expectLabelsOk(ctx);
  });

  it('§8.1 step 4 (C-054, C-294): one chain failing marks both its rows unavailable, keeps old values, adds the note, logs chain_ids_unavailable', async () => {
    const ctx = makeTestContext();
    seedBalances(ctx.repos, { [BASE]: { ETH: '0.2', USDC: '55' } }, '2026-11-05T10:00:00.000Z');
    ctx.rpc.down.add(BASE);
    ctx.rpc.eth.set(SEP, 10n ** 18n);
    const r = await s0.step(ctx);
    expect(r).toEqual({ kind: 'continue' });
    for (const token of ['ETH', 'USDC'] as const) {
      const row = ctx.repos.db4.get(BASE, token);
      expect(row?.status).toBe('unavailable');
    }
    expect(ctx.repos.db4.get(BASE, 'ETH')?.balance).toBe('0.2');
    expect(ctx.repos.db4.get(BASE, 'USDC')?.balance).toBe('55');
    expect(ctx.repos.db4.get(SEP, 'ETH')?.status).toBe('ok');
    expect(ctx.req.notes).toEqual(["Base Sepolia balance couldn't be read right now, so it wasn't used."]);
    expect(ctx.log.lines.some((l) => JSON.stringify(l.chain_ids_unavailable) === JSON.stringify([BASE]))).toBe(true);
    expect(ctx.log.lines.some((l) => l.event === 'balances_unavailable' || l.chain_ids_unavailable)).toBe(true);
    expectLabelsOk(ctx);
  });

  it('§8.1 step 4: ETH ok but USDC failing on a chain still makes that chain unavailable (both rows)', async () => {
    const ctx = makeTestContext();
    const orig = ctx.rpc.getUsdcBalance.bind(ctx.rpc);
    ctx.rpc.getUsdcBalance = async (c) => {
      if (c === ARB) throw new Error('timeout');
      return orig(c);
    };
    await s0.step(ctx);
    expect(ctx.repos.db4.get(ARB, 'ETH')?.status).toBe('unavailable');
    expect(ctx.repos.db4.get(ARB, 'USDC')?.status).toBe('unavailable');
  });

  it('§8.1 step 5 (C-055, C-364): every chain unavailable → BALANCES_UNAVAILABLE naming the chains', async () => {
    const ctx = makeTestContext();
    ctx.rpc.down.add(SEP).add(BASE).add(ARB);
    const r = await s0.step(ctx);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.code).toBe('BALANCES_UNAVAILABLE');
    expect(r.params?.chains).toBe('Sepolia, Base Sepolia and Arbitrum Sepolia');
    expect(ERROR_MESSAGE.BALANCES_UNAVAILABLE(r.params ?? {})).toBe(
      "I can't read your balances on Sepolia, Base Sepolia and Arbitrum Sepolia right now. Try again in a moment.",
    );
  });

  it('§8.1 (C-056): S0 asks no questions and has no AnswerHandler (runs only for new messages)', () => {
    expect(s0.onAnswer).toBeUndefined();
  });
});
