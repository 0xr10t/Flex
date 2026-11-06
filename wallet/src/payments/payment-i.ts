// Implements: §14.2 rules 1, 3 and 8, Appendix A.3 `i`, A.5 rules 1, 3 and 5. One transaction from the user's account to
// itself: execute(BatchDefault, one call per recipient). USDC is a transfer on the token, never native value (B1).
// Always a batch, even for one recipient (A.5 rule 3).

import { encodeAbiParameters, encodeFunctionData, erc20Abi, parseEventLogs, type Hex, type Log } from 'viem';
import type { Execution } from '../chain/redeem.v2.js';
import { asUpgraded } from '../guard/check.js';
import { ETH, decodeCall, decodeExecuteBatch, describeCall, movementsOfCalls } from '../guard/decode.js';
import { finished, type StepHandler } from '../runner/handler.js';
import type { PaymentI } from '../schemas/envelope.js';

const BATCH_DEFAULT = '0x0100000000000000000000000000000000000000000000000000000000000000' as const;

const EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: '_mode', type: 'bytes32' },
      { name: '_executionCalldata', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

const EXECUTIONS = [
  {
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ],
  },
] as const;

export const summaryOf = (calls: readonly Execution[], token: string): string[] =>
  calls.map((c) =>
    describeCall(
      decodeCall(c),
      () => (token === 'ETH' ? 18 : 6),
      () => token,
    ),
  );

export const paymentHandler: StepHandler<PaymentI> = {
  chainOf: (intent) => intent.chain_id,
  plan: async (ctx, intent) => {
    const data = encodeExecuteBatch(callsOf(intent));
    const wallet = ctx.walletAddress;
    const token = intent.token === 'ETH' ? ETH : (intent.token_address as Hex);
    return {
      kind: 'check',
      check: {
        blocks: [{ calls: [{ from: wallet, to: wallet, data }], stateOverrides: asUpgraded(wallet) }],
        decode: () => {
          const calls = decodeExecuteBatch(data);
          return calls && movementsOfCalls(calls.map(decodeCall), wallet);
        },
        movements: intent.recipients.map((r) => ({
          token,
          from: wallet,
          to: r.recipient,
          value: BigInt(r.amount.base_units),
        })),
        events: [],
        summary: summaryOf(decodeExecuteBatch(data) ?? [], intent.token),
      },
    };
  },
  prepare: async (ctx, intent) => ({
    kind: 'tx',
    tx: { to: ctx.walletAddress, data: encodeExecuteBatch(callsOf(intent)) },
  }),
  settled: async (ctx, intent, receipt, hash) =>
    finished(
      paymentTookEffect(intent, ctx.walletAddress, receipt.logs)
        ? { status: 'executed', tx_hash: hash, executed_at: receipt.executedAt }
        : { status: 'failed', tx_hash: hash, error_code: 'EFFECT_MISSING' },
    ),
};

export function callsOf(intent: PaymentI): Execution[] {
  return intent.recipients.map((r) => {
    const units = BigInt(r.amount.base_units);
    if (intent.token === 'ETH') return { target: r.recipient, value: units, callData: '0x' as Hex };
    return {
      target: intent.token_address as Hex,
      value: 0n,
      callData: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [r.recipient, units] }),
    };
  });
}

export function encodeExecuteBatch(calls: Execution[]): Hex {
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: [BATCH_DEFAULT, encodeAbiParameters(EXECUTIONS, [calls])],
  });
}

/**
 * Rule 8: success means the money moved, not that the receipt succeeded (B1 was a successful transaction that paid 0 USDC).
 * USDC: exactly one Transfer from the wallet per recipient, for the exact amount, from the expected token.
 * ETH: plain transfers emit no log, and a balance read can be skewed by other incoming funds, so this relies on the
 * receipt. BatchDefault reverts as a whole when one call fails (B4), and `ensureUpgraded` has confirmed the account's code.
 */
export function paymentTookEffect(intent: PaymentI, from: Hex, logs: Log[]): boolean {
  if (intent.token === 'ETH') return true;
  const token = (intent.token_address as Hex).toLowerCase();
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs, strict: true }).filter(
    (l) => l.address.toLowerCase() === token && l.args.from.toLowerCase() === from.toLowerCase(),
  );
  if (transfers.length !== intent.recipients.length) return false;
  return intent.recipients.every((r) =>
    transfers.some(
      (t) => t.args.to.toLowerCase() === r.recipient.toLowerCase() && t.args.value === BigInt(r.amount.base_units),
    ),
  );
}
