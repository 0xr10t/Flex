// Implements: §13.2 balance answer: every allowed chain in `allowed_chain_ids` order, raw ETH with spendable ETH (§10.1),
// USDC, unreadable chains, totals of the readable chains. Lane B's S4 and S11 (§8.5 rule 3, SQB-15) call it.

import type { BuildBalanceAnswer } from '../contracts/step.js';
import { chainName, fmt } from '../plan/common.js';
import { readBalances } from '../plan/spendable.js';
import { BALANCE } from './templates.js';

export const buildBalanceAnswer: BuildBalanceAnswer = (ctx) => {
  const lines: string[] = [BALANCE.HEADER()];
  let totalEth = 0n;
  let totalUsdc = 0n;
  let firstReadable = true;
  for (const b of readBalances(ctx)) {
    const chain = chainName(ctx, b.chain_id);
    if (!b.ok) {
      lines.push(BALANCE.CHAIN_UNREADABLE({ chain }));
      continue;
    }
    const line = firstReadable ? BALANCE.CHAIN_FIRST : BALANCE.CHAIN;
    firstReadable = false;
    lines.push(
      line({
        chain,
        eth: fmt(b.raw.ETH, 'ETH'),
        eth_spendable: fmt(b.spendable.ETH, 'ETH'),
        usdc: fmt(b.raw.USDC, 'USDC'),
      }),
    );
    totalEth += b.raw.ETH;
    totalUsdc += b.raw.USDC;
  }
  lines.push(BALANCE.TOTAL({ eth: fmt(totalEth, 'ETH'), usdc: fmt(totalUsdc, 'USDC') }));
  return [lines.join('\n')];
};
