// Implements: §9.3 step 3 (target chain known: exactly one chain word in the span's clause or in the whole prompt;
// otherwise every allowed `ok` chain), §9.6 step 2 (group chain), §13.1 chain display names from config.

import type { StepContext } from '../contracts/step.js';
import type { ChainId, LexicalScan } from '../contracts/types.js';

/** Display name of a chain from config (§13.1). */
export function chainName(ctx: StepContext, chain_id: ChainId): string {
  return ctx.config.chains.find((c) => c.chain_id === chain_id)?.name ?? String(chain_id);
}

/** Allowed chains (DB5 order) whose DB4 rows have status 'ok' for this request (§8.1, §10.1). */
export function okChains(ctx: StepContext): ChainId[] {
  return ctx.limits.allowed_chain_ids.filter((c) => {
    const usdc = ctx.repos.db4.get(c, 'USDC');
    const eth = ctx.repos.db4.get(c, 'ETH');
    return usdc?.status === 'ok' || eth?.status === 'ok';
  });
}

/**
 * §9.3 step 3 / §9.6 step 2: exactly one chain word in the span's clause → that chain; else exactly one chain word
 * in the whole prompt → that chain; else null (unknown). Several mentions of the same chain count as one chain word.
 */
export function statedChain(scan: LexicalScan, clause_index: number | null): ChainId | null {
  if (clause_index !== null) {
    const inClause = distinct(scan.chains.filter((c) => c.clause_index === clause_index).map((c) => c.chain_id));
    if (inClause.length === 1) return inClause[0] ?? null;
  }
  const all = distinct(scan.chains.map((c) => c.chain_id));
  return all.length === 1 ? (all[0] ?? null) : null;
}

/** SQ-06 (b): chain names joined with ", " and a final " and ". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function distinct<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
