// Lane D tester helpers for S9 (plan) tests; reused by later S10–S12 tests. Spec refs: §10, §19.
import { expect } from 'vitest';
import type { StepResult } from '../../../src/contracts/step.js';
import type {
  AddressPh,
  Answer,
  ChainId,
  InternalIntent,
  Payment,
  PlanI,
  PlanJ,
  PlanK,
  PlanL,
  Token,
} from '../../../src/contracts/types.js';
import { s9 } from '../../../src/pipeline/s9-plan.js';
import { validators } from '../../../src/schemas/index.js';
import type { TestContext } from '../../fakes/context.js';
import {
  ARB,
  BASE,
  MIHIR_CS,
  SEPOLIA,
  addAmount,
  addChrono,
  addRecipient,
  ctxD,
  pay,
  setClauses,
  type Bal,
  type SchedFields,
} from './helpers.js';

export const NOW_E6 = '2026-11-05T17:30:00Z'; // Thu 2026-11-05 23:00 Asia/Kolkata
export const PENDING_RECENT = '2026-11-05T17:25:00.000Z'; // 5 min before NOW_E6
export const PENDING_OLD = '2026-11-05T17:19:00.000Z'; // 11 min before NOW_E6

export const chip = (chip_id: string): Answer => ({ kind: 'chip', chip_id });
export const text = (t: string): Answer => ({ kind: 'text', text: t });

export function planOf(ctx: TestContext): InternalIntent[] {
  expect(ctx.req.plan).toBeDefined();
  return ctx.req.plan as InternalIntent[];
}
export const asI = (x: InternalIntent | undefined): PlanI => {
  expect(x?.intent_id).toBe('i');
  return x as PlanI;
};
export const asJ = (x: InternalIntent | undefined): PlanJ => {
  expect(x?.intent_id).toBe('j');
  return x as PlanJ;
};
export const asK = (x: InternalIntent | undefined): PlanK => {
  expect(x?.intent_id).toBe('k');
  return x as PlanK;
};
export const asL = (x: InternalIntent | undefined): PlanL => {
  expect(x?.intent_id).toBe('l');
  return x as PlanL;
};

/** V-01: the plan satisfies the internal plan JSON schema (and steps are numbered 0..n-1). */
export function expectValidPlan(ctx: TestContext): void {
  const plan = planOf(ctx);
  const ok = validators.internalPlan(plan);
  expect(validators.internalPlan.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
  expect(plan.map((p) => p.step)).toEqual(plan.map((_, i) => i));
}

export async function run(ctx: TestContext, payments: Payment[]): Promise<StepResult> {
  ctx.req.payments = payments;
  return s9.step(ctx);
}

export async function runOk(ctx: TestContext, payments: Payment[]): Promise<InternalIntent[]> {
  const r = await run(ctx, payments);
  expect(r).toEqual({ kind: 'continue' });
  expectValidPlan(ctx);
  return planOf(ctx);
}

/** Answers the last question and re-enters the step (runner semantics, step.ts header). */
export async function answerAndReenter(
  ctx: TestContext,
  q: Extract<StepResult, { kind: 'question' }>['question'],
  a: Answer,
): Promise<{ answer: StepResult; next?: StepResult }> {
  const answer = await s9.onAnswer?.(ctx, q, a);
  if (!answer) throw new Error('s9.onAnswer missing');
  if (answer.kind !== 'continue') return { answer };
  return { answer, next: await s9.step(ctx) };
}

export function amountOf(ctx: TestContext, ph: string): string | undefined {
  return ctx.repos.db1.get(ph as never)?.amount;
}

export function db1Count(ctx: TestContext): number {
  return ctx.repos.db1.listByRequest(ctx.req.request_id).length;
}

/** USDC balances by chain (ETH stays at the ctxD default 0.1). */
export function usdc(sepolia: string, base: string, arb: string): Bal {
  return { [SEPOLIA]: { USDC: sepolia }, [BASE]: { USDC: base }, [ARB]: { USDC: arb } };
}

/** An `i` payment of `amount` to a recipient. */
export function iPay(
  ctx: TestContext,
  amount: string,
  recipient: AddressPh,
  chain: ChainId | 'unstated' = 'unstated',
  o: { token?: Token; pinned?: ChainId; relative?: 'all' | 'half' | 'max' } = {},
): Payment {
  const a = addAmount(ctx, amount, {
    ...(o.token ? { token: o.token } : {}),
    ...(o.pinned !== undefined ? { pinned_chain_id: o.pinned, relative: o.relative ?? 'max' } : {}),
  });
  return pay(ctx, 'i', a, recipient, chain);
}

export interface KOpts extends SchedFields {
  amount?: string;
  clause?: string;
  balances?: Bal;
  now?: string;
  timezone?: string;
  chrono?: Array<{ kind: 'time' | 'date' | 'start' | 'end'; date?: string; time?: string }>;
  chain?: ChainId | 'unstated';
}

/** One `k` payment to Mihir (all three chains). Default balances: Sepolia 0, Base 1000, Arbitrum 500. */
export function kSetup(o: KOpts = {}): { ctx: TestContext; payment: Payment; recipient: AddressPh } {
  const ctx = ctxD({
    actions: ['k'],
    balances: o.balances ?? usdc('0', '1000', '500'),
    ...(o.now !== undefined ? { now: o.now } : {}),
    ...(o.timezone !== undefined ? { timezone: o.timezone } : {}),
  });
  setClauses(ctx, [o.clause ?? 'pay mihir 10 usdc every friday']);
  const a = addAmount(ctx, o.amount ?? '10', { clause: 0 });
  const r = addRecipient(ctx, { name: 'Mihir', address: MIHIR_CS, source: 'contact' });
  for (const c of o.chrono ?? []) addChrono(ctx, c.kind, c, 0);
  const payment = pay(ctx, 'k', a, r, o.chain ?? 'unstated', {
    frequency: o.frequency === undefined ? 'weekly' : o.frequency,
    interval: o.interval ?? null,
    times_per_week: o.times_per_week ?? null,
    days_of_week: o.days_of_week === undefined ? ['FRI'] : o.days_of_week,
    day_of_month: o.day_of_month ?? null,
  });
  return { ctx, payment, recipient: r };
}
