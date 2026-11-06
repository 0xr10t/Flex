// Implements: §10.1 spendable balance (DB4 − pending DB6 rows of the last 10 minutes of kinds payment / bridge_out /
// autopay_prefund − ETH gas reserve, floored at 0; unavailable chains excluded; bigint base units), §10.4 gas check
// input (raw ETH − pending ETH, SQ-16), §11.2 V-11, §15 INSUFFICIENT_FUNDS params (SQ-08, F-10).

import type { StepContext, StepResult } from '../contracts/step.js';
import type { ChainId, Token } from '../contracts/types.js';
import { toBaseUnits } from '../contracts/money.js';
import { insufficientFundsParams } from '../contracts/catalog.js';
import { chainName, nowUtcIso } from '../pipeline/step-util.js';
import { decimalsOf, fmt } from './common.js';

export const TOKENS_ORDER: readonly Token[] = ['USDC', 'ETH'];

export interface ChainBalance {
  chain_id: ChainId;
  /** Both DB4 rows present with status 'ok'. */
  ok: boolean;
  raw: Record<Token, bigint>;
  pending: Record<Token, bigint>;
  spendable: Record<Token, bigint>;
  /** eth_gas_reserve[c] in wei. */
  reserve: bigint;
}

function gasReserve(ctx: StepContext, chain_id: ChainId): bigint {
  const v = ctx.limits.eth_gas_reserve[String(chain_id)];
  return v === undefined ? 0n : toBaseUnits(v, 18);
}

/** One entry per chain in `allowed_chain_ids`, in that order. */
export function readBalances(ctx: StepContext): ChainBalance[] {
  const now = nowUtcIso(ctx);
  return ctx.limits.allowed_chain_ids.map((chain_id) => {
    const rows = TOKENS_ORDER.map((t) => ctx.repos.db4.get(chain_id, t));
    const ok = rows.every((r) => r?.status === 'ok');
    const raw = { USDC: 0n, ETH: 0n } as Record<Token, bigint>;
    const pending = { USDC: 0n, ETH: 0n } as Record<Token, bigint>;
    const spendable = { USDC: 0n, ETH: 0n } as Record<Token, bigint>;
    const reserve = gasReserve(ctx, chain_id);
    if (ok) {
      TOKENS_ORDER.forEach((t, n) => {
        const row = rows[n];
        raw[t] = row ? BigInt(row.base_units) : 0n;
        pending[t] = ctx.repos.db6
          .pendingRecent(chain_id, t, now)
          .reduce((s, r) => s + toBaseUnits(r.amount, decimalsOf(t)), 0n);
        const s = raw[t] - pending[t] - (t === 'ETH' ? reserve : 0n);
        spendable[t] = s > 0n ? s : 0n;
      });
    }
    return { chain_id, ok, raw, pending, spendable, reserve };
  });
}

export function balanceOf(balances: ChainBalance[], chain_id: ChainId): ChainBalance | undefined {
  return balances.find((b) => b.chain_id === chain_id);
}

/** §10.4 gas check: raw ETH − pending ETH ≥ eth_gas_reserve[c]. */
function hasGas(b: ChainBalance): boolean {
  return b.ok && b.raw.ETH - b.pending.ETH >= b.reserve;
}

/** §10.3 rule 2 / V-05: the chain is in `allowed_chain_ids` and its balances are readable. */
export function checkChain(ctx: StepContext, balances: ChainBalance[], c: ChainId): StepResult | null {
  if (!ctx.limits.allowed_chain_ids.includes(c)) {
    return { kind: 'error', code: 'CHAIN_NOT_ALLOWED', params: { chain: chainName(ctx.config, c) } };
  }
  if (!balanceOf(balances, c)?.ok) {
    return { kind: 'error', code: 'BALANCES_UNAVAILABLE', params: { chains: chainName(ctx.config, c) } };
  }
  return null;
}

/** §10.4 gas check / V-11 for every touched chain, in `allowed_chain_ids` order. */
export function checkGas(
  ctx: StepContext,
  balances: ChainBalance[],
  touched: ReadonlySet<ChainId>,
  fees: ReadonlyMap<ChainId, bigint> = new Map(),
): StepResult | null {
  const { limits } = ctx;
  for (const c of limits.allowed_chain_ids) {
    if (!touched.has(c)) continue;
    const b = balanceOf(balances, c);
    const required = (b?.reserve ?? 0n) + (fees.get(c) ?? 0n);
    if (b && hasGas(b) && b.raw.ETH - b.pending.ETH >= required) continue;
    return {
      kind: 'error',
      code: 'NO_GAS',
      params: { reserve: fmt(required, 'ETH'), chain: chainName(ctx.config, c) },
    };
  }
  return null;
}

/**
 * §15 INSUFFICIENT_FUNDS params (SQ-08, F-10): the total across the readable chains, and each chain with a positive
 * spendable amount of the token, in configured chain order (unreadable chains left out).
 */
export function insufficientParams(
  ctx: StepContext,
  token: Token,
  balances: ChainBalance[],
  needTotal: bigint,
): Record<string, string> {
  const order = (c: ChainId): number => ctx.config.chains.findIndex((x) => x.chain_id === c);
  const positive = balances
    .filter((b) => b.ok && b.spendable[token] > 0n)
    .sort((x, y) => order(x.chain_id) - order(y.chain_id));
  const have = positive.reduce((sum, b) => sum + b.spendable[token], 0n);
  return insufficientFundsParams({
    token,
    need: fmt(needTotal, token),
    have: fmt(have, token),
    chains: positive.map((b) => ({
      name: chainName(ctx.config, b.chain_id),
      spendable: fmt(b.spendable[token], token),
    })),
  });
}
