import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { checkEnvelope } from '@flex/protocol';
import type { Address, Token, Weekday } from '../../../src/contracts/types.js';
import { swapBack } from '../../../src/handoff/swap-back.js';
import { buildSummary } from '../../../src/messages/summary.js';
import { terminalError } from '../../../src/plan/pairing-checks.js';
import { s9 } from '../../../src/pipeline/s9-plan.js';
import { s10 } from '../../../src/pipeline/s10-validate.js';
import {
  addAmount,
  addGroup,
  BASE,
  ARB,
  ctxD,
  pay,
  setClauses,
  setLimits,
  WALLET_CS,
  ZERO_ADDRESS,
  USDC_ADDR,
} from './helpers.js';
import { amountOf, answerAndReenter, asK, run, runOk, text } from './s9-helpers.js';

function setup(
  options: { count?: number; amount?: string; token?: Token; days?: Weekday[]; balance?: string; other?: string } = {},
) {
  const token = options.token ?? 'USDC';
  const ctx = ctxD({
    actions: ['k'],
    balances: {
      [BASE]: { [token]: options.balance ?? (token === 'USDC' ? '1000' : '1') },
      [ARB]: { USDC: options.other ?? '0' },
    },
  });
  setClauses(ctx, ['pay everyone in team.eth every Friday for 4 payments on Base']);
  const selected = Array.from({ length: options.count ?? 2 }, (_, n) => ({
    subname: `${String(n).padStart(3, '0')}.team.eth`,
    address: getAddress(`0x${(1000 + n).toString(16).padStart(40, '0')}`),
  }));
  const { group, members } = addGroup(ctx, { parent: 'team.eth', chain_id: BASE, members: [...selected].reverse() });
  const amount = addAmount(ctx, options.amount ?? '10', { token });
  const payment = pay(ctx, 'k', amount, group, BASE, { frequency: 'weekly', days_of_week: options.days ?? ['FRI'] });
  return { ctx, group, members, selected, amount, payment };
}

describe('recurring ENS groups use the shared atomic autopay intent', () => {
  it('funds all members with one fee per run and keeps the confirmation explicit', async () => {
    const { ctx, selected, payment } = setup({ balance: '80.2' });
    const plan = await runOk(ctx, [payment]);
    expect(plan).toHaveLength(1);
    expect(await s10.step(ctx)).toEqual({ kind: 'continue' });
    const env = swapBack(ctx, plan);
    const k = env.intents[0];
    expect(k).toMatchObject({
      intent_id: 'k',
      recipients: selected.map((m) => ({
        recipient: m.address,
        amount: { value: '10', base_units: '10000000', decimals: 6 },
      })),
      fee: { amount: { value: '0.05' } },
      schedule: { max_runs: 4 },
      limits: { max_per_run: { value: '20.05' }, max_total: { value: '80.2' } },
    });
    expect(checkEnvelope(env, { nowMs: ctx.now().toMillis() }).ok).toBe(true);
    const summary = buildSummary(ctx, plan);
    expect(summary.lines[0]).toContain('10 USDC to 000.team.eth');
    expect(summary.lines[0]).toContain('10 USDC to 001.team.eth');
    expect(summary.notes.join(' ')).toContain('later ENS group changes do not update this plan');
    expect(summary.notes.join(' ')).toContain('Cancelling through any member cancels the whole group plan');
    expect(ctx.exec.submissions).toEqual([]);
  });

  it('rejects a one-base-unit funding shortfall instead of dropping a member or underfunding fees', async () => {
    const { ctx, payment } = setup({ balance: '80.199999' });
    expect(await run(ctx, [payment])).toMatchObject({ kind: 'error', code: 'INSUFFICIENT_FUNDS' });
    expect(ctx.req.plan).toBeUndefined();
  });

  it('bridges the aggregate shortfall once and shares it across weekday legs', async () => {
    const { ctx, selected, payment } = setup({ balance: '50', other: '100', days: ['MON', 'THU'] });
    const plan = await runOk(ctx, [payment]);
    expect(await s10.step(ctx)).toEqual({ kind: 'continue' });
    const env = swapBack(ctx, plan);
    expect(env.intents.map((i) => i.intent_id)).toEqual(['j', 'k', 'k']);
    expect(env.intents[0]).toMatchObject({ amount: { value: '30.2' }, funds_steps: [1, 2] });
    for (const k of env.intents.slice(1)) {
      expect(k).toMatchObject({
        recipients: selected.map((m) => ({ recipient: m.address })),
        depends_on: [0],
        schedule: { max_runs: 2 },
        fee: { amount: { value: '0.05' } },
        limits: { max_per_run: { value: '20.05' }, max_total: { value: '40.1' } },
      });
    }
    expect(amountOf(ctx, asK(plan[1]).display.per_period_cap)).toBe('40');
  });

  it('uses 18-decimal ETH amounts, includes one fee, and reserves native gas', async () => {
    const { ctx, payment } = setup({ token: 'ETH', amount: '0.001', balance: '0.01008' });
    const plan = await runOk(ctx, [payment]);
    expect(await s10.step(ctx)).toEqual({ kind: 'continue' });
    expect(swapBack(ctx, plan).intents[0]).toMatchObject({
      token: 'ETH',
      recipients: [
        { amount: { base_units: '1000000000000000', decimals: 18 } },
        { amount: { base_units: '1000000000000000', decimals: 18 } },
      ],
      fee: { amount: { value: '0.00002' } },
      limits: { max_per_run: { value: '0.00202' }, max_total: { value: '0.00808' } },
    });
  });

  it('keeps the group on its selected chain', async () => {
    const { ctx, payment } = setup();
    expect(await run(ctx, [{ ...payment, chain: ARB }])).toMatchObject({ kind: 'error', code: 'UNSUPPORTED_REQUEST' });
    expect(ctx.req.plan).toBeUndefined();
  });

  it.each([1, 50, 51])(
    'enforces the recurring recipient boundary at %i members even with a policy override',
    async (count) => {
      const { ctx, payment } = setup({ count, amount: '0.01' });
      ctx.req.limit_override = true;
      setLimits(ctx, { max_group_size: 1000 });
      const result = await run(ctx, [payment]);
      if (count === 51) expect(result).toEqual({ kind: 'error', code: 'LIMIT_GROUP_SIZE' });
      else {
        expect(result).toEqual({ kind: 'continue' });
        expect(asK(ctx.req.plan![0]).recipients).toHaveLength(count);
        expect(await s10.step(ctx)).toEqual({ kind: 'continue' });
      }
    },
  );

  it('honors a smaller configured group limit', async () => {
    const { ctx, payment } = setup();
    setLimits(ctx, { max_group_size: 1 });
    expect(await run(ctx, [payment])).toEqual({ kind: 'error', code: 'LIMIT_GROUP_SIZE' });
  });

  it('counts every member in weekly policy while applying the payment limit to each payee', async () => {
    const { ctx, payment } = setup({ days: ['MON', 'THU'] });
    setLimits(ctx, { per_tx_max: { USDC: '15', ETH: '0.05' }, autopay_max_per_period: { USDC: '30', ETH: '0.05' } });
    const plan = await runOk(ctx, [payment]);
    expect(amountOf(ctx, asK(plan[0]).display.per_period_cap)).toBe('40');
    expect(await s10.step(ctx)).toMatchObject({ kind: 'question', question: { code: 'Q_LIMIT_OVERRIDE' } });
    setLimits(ctx, { autopay_max_per_period: { USDC: '40', ETH: '0.05' } });
    expect(await s10.step(ctx)).toEqual({ kind: 'continue' });
  });

  it.each(['span', 'group', 'member', 'amount'] as const)(
    'blocks untrusted %s provenance in both pairing and final validation',
    async (source) => {
      const { ctx, group, members, amount, payment } = setup();
      if (source === 'span') ctx.req.spans[0]!.source = 'untrusted';
      if (source === 'group') ctx.repos.tables.db3.get(group)!.source = 'untrusted';
      if (source === 'member') ctx.repos.tables.db3.get(Object.values(members)[0]!)!.source = 'untrusted';
      if (source === 'amount') ctx.repos.tables.db1.get(amount)!.source = 'untrusted';
      expect(terminalError(ctx, [payment])).toEqual({ kind: 'error', code: 'UNTRUSTED_IN_AUTOPAY' });
      await runOk(ctx, [payment]); // Even a bypass of S8 must fail at the handoff validation boundary.
      expect(await s10.step(ctx)).toEqual({ kind: 'error', code: 'UNTRUSTED_IN_AUTOPAY' });
      expect(ctx.exec.submissions).toEqual([]);
    },
  );

  it.each(['self', 'zero', 'token', 'fee', 'duplicate'] as const)(
    'rejects a %s payee before confirmation',
    async (invalid) => {
      const { ctx, members, payment } = setup();
      const rows = Object.values(members).map((m) => ctx.repos.tables.db3.get(m)!);
      const addresses: Record<typeof invalid, Address> = {
        self: WALLET_CS,
        zero: ZERO_ADDRESS,
        token: USDC_ADDR[BASE],
        fee: ctx.config.autopay!.fee_collector,
        duplicate: rows[1]!.address!,
      };
      rows[0]!.address = addresses[invalid];
      await runOk(ctx, [payment]);
      expect(await s10.step(ctx)).toMatchObject({
        kind: 'error',
        code: invalid === 'self' || invalid === 'zero' ? 'SELF_PAYMENT' : 'EXECUTION_PLAN_INVALID',
      });
      expect(ctx.exec.submissions).toEqual([]);
    },
  );

  it('asks once when both weekday legs have passed, then replans the entire group', async () => {
    const { ctx, payment } = setup({ days: ['MON', 'THU'] });
    const plan = await runOk(ctx, [payment]);
    const later = DateTime.fromSeconds(Math.max(...plan.map((it) => asK(it).schedule.start_at)) + 1);
    ctx.now = () => later.setZone(ctx.timezone);
    const question = s9.beforeHandoff!(ctx);
    expect(question).toMatchObject({ kind: 'question', question: { code: 'Q_AUTOPAY_START' } });
    if (question?.kind !== 'question') throw new Error('start question expected');
    const reply = await answerAndReenter(ctx, question.question, text(later.plus({ days: 1 }).toISODate()!));
    expect(reply.next).toEqual({ kind: 'continue' });
    expect(ctx.req.plan).toHaveLength(2);
    for (const it of ctx.req.plan!) {
      expect(asK(it).recipients).toHaveLength(2);
      expect(asK(it).schedule.start_at).toBeGreaterThan(ctx.now().toSeconds());
    }
    expect(await s10.step(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.exec.submissions).toEqual([]);
  });
});
