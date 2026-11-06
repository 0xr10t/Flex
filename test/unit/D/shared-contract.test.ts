import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { checkEnvelope } from '@flex/protocol';
import { swapBack } from '../../../src/handoff/swap-back.js';
import { s10 } from '../../../src/pipeline/s10-validate.js';
import { addAmount, addAutopay, addGroup, addMihir, ctxD, pay, setLimits, BASE } from './helpers.js';
import { run, runOk } from './s9-helpers.js';

describe('agent plans obey the shared wallet boundaries', () => {
  it.each([100, 101])('handles a group of %i without expanding beyond the atomic recipient limit', async (count) => {
    const ctx = ctxD({ balances: { [BASE]: { USDC: '100' } } });
    const { group } = addGroup(ctx, {
      parent: 'team.eth',
      chain_id: BASE,
      members: Array.from({ length: count }, (_, n) => ({
        subname: `${String(n).padStart(3, '0')}.team.eth`,
        address: getAddress(`0x${(1000 + n).toString(16).padStart(40, '0')}`),
      })),
    });
    const result = await run(ctx, [pay(ctx, 'i', addAmount(ctx, '0.01'), group, BASE)]);
    if (count === 101) {
      expect(result).toMatchObject({ kind: 'error', code: 'LIMIT_GROUP_SIZE' });
      return;
    }
    expect(result.kind).toBe('continue');
    expect((await s10.step(ctx)).kind).toBe('continue');
    const env = swapBack(ctx, ctx.req.plan!);
    expect(env.intents).toHaveLength(1);
    expect(env.intents[0]).toMatchObject({ intent_id: 'i', recipients: expect.any(Array) });
    if (env.intents[0]?.intent_id !== 'i') throw new Error('payment expected');
    expect(env.intents[0].recipients).toHaveLength(100);
    expect(env.intents[0].recipients.reduce((sum, p) => sum + BigInt(p.amount.base_units), 0n)).toBe(1_000_000n);
    expect(checkEnvelope(env, { nowMs: ctx.now().toMillis() }).ok).toBe(true);
    expect(JSON.stringify(env)).not.toMatch(/address_[a-f0-9]{8}|amount_[a-f0-9]{8}|reused_from_chain_id|display/);
  });

  it.each([16, 17])(
    'keeps repeated payees in separate steps and enforces the %i-step boundary before approval',
    async (count) => {
      const ctx = ctxD({ balances: { [BASE]: { USDC: '100' } } });
      setLimits(ctx, { max_bridges_per_request: 99 }); // policy overrides cannot relax protocol limits
      const recipient = addMihir(ctx);
      const amount = addAmount(ctx, '0.01');
      await runOk(
        ctx,
        Array.from({ length: count }, () => pay(ctx, 'i', amount, recipient, BASE)),
      );
      expect(ctx.req.plan).toHaveLength(count);
      const result = await s10.step(ctx);
      if (count === 16) expect(result.kind).toBe('continue');
      else expect(result).toMatchObject({ kind: 'error', code: 'LIMIT_INTENTS' });
      expect(ctx.exec.submissions).toEqual([]);
    },
  );

  it('distinguishes a legacy active autopay without a plan ID from a pending v2 setup', async () => {
    const ctx = ctxD({ actions: ['l'] });
    addAutopay(ctx, { autopay_id: 'ap_000000000001', status: 'active', delegate: null });
    expect(await run(ctx, [pay(ctx, 'l', null, addMihir(ctx))])).toMatchObject({
      kind: 'error',
      code: 'LEGACY_AUTOPAY_UNSUPPORTED',
    });
    expect(ctx.exec.submissions).toEqual([]);
  });
});
