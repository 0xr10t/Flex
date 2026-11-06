// Implements: §14.2 rule 4, Appendix A.3 `j`, A.4, A.5 rules 6-8. One batch: approve exactly the amount, then ccipSend with exactly
// the quoted fee (the router keeps any overpayment), always to the user's own address. A dependent step starts only once the
// USDC has arrived.
//
// OQ-07 (provisional): arrival is a USDC Transfer to the wallet on the destination, for the exact amount, after the send. Checked
// from logs rather than the balance, so the wallet's other spending can't hide an arrival. Unproven on the live lanes, which burn
// and mint through CCTP (F-7, F-8). If it doesn't arrive in time the step reports failed, though the money may still come.

import {
  concat,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  getAbiItem,
  parseAbi,
  parseEther,
  parseEventLogs,
  type Hex,
} from 'viem';
import { scanLogs } from '../autopay/scan.js';
import type { Execution } from '../chain/redeem.v2.js';
import { asUpgraded, type Check } from '../guard/check.js';
import { ETH, decodeCall, decodeExecuteBatch, describeCall, movementsOfCalls, type Movement } from '../guard/decode.js';
import { encodeExecuteBatch } from '../payments/payment-i.js';
import { finished, type StepHandler } from '../runner/handler.js';
import { CCIP } from '../schemas/bridge.v2.js';
import type { BridgeJ, ChainId } from '../schemas/envelope.js';

const ROUTER_ABI = parseAbi([
  'struct TokenAmount { address token; uint256 amount; }',
  'struct Message { bytes receiver; bytes data; TokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }',
  'function getFee(uint64 destSelector, Message message) view returns (uint256)',
  'function ccipSend(uint64 destSelector, Message message) payable returns (bytes32)',
]);

const TRANSFER_EVENT = getAbiItem({ abi: erc20Abi, name: 'Transfer' });

// GenericExtraArgsV2: gasLimit 0, out-of-order allowed. A plain token transfer needs no receiver gas (A.3).
const EXTRA_ARGS = concat(['0x181dcf10', encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }], [0n, true])]);

export const ccipMessage = (intent: BridgeJ, wallet: Hex) => ({
  receiver: encodeAbiParameters([{ type: 'address' }], [wallet]),
  data: '0x' as Hex,
  tokenAmounts: [{ token: intent.source_token_address, amount: BigInt(intent.amount.base_units) }],
  feeToken: '0x0000000000000000000000000000000000000000' as Hex,
  extraArgs: EXTRA_ARGS,
});

interface WaitData {
  fee_wei: string;
  dest_from_block: number;
  arrive_by_ms: number;
}

const routerOf = (chainId: ChainId) => CCIP[chainId];

/** Reads the batch's raw bytes, and returns what it moves, or null if it breaks a bridge rule. Tested with tampered bytes. */
export function decodeBridgeBatch(data: Hex, intent: BridgeJ, wallet: Hex, quoted: bigint): Movement[] | null {
  const router = routerOf(intent.source_chain_id).router;
  const selector = routerOf(intent.dest_chain_id).selector;
  const amount = BigInt(intent.amount.base_units);
  const calls = (decodeExecuteBatch(data) ?? []).map(decodeCall);
  const [approve, send] = calls;
  if (calls.length !== 2 || approve?.kind !== 'approve' || send?.kind !== 'ccipSend') return null;
  const token = intent.source_token_address.toLowerCase();
  const good =
    approve.token.toLowerCase() === token &&
    approve.spender.toLowerCase() === router.toLowerCase() &&
    approve.value === amount &&
    send.router.toLowerCase() === router.toLowerCase() &&
    send.selector === selector &&
    send.receiver.toLowerCase() === wallet.toLowerCase() &&
    send.token.toLowerCase() === token &&
    send.value === amount &&
    send.fee === quoted &&
    send.feeToken === '0x0000000000000000000000000000000000000000' &&
    send.data === '0x';
  return good ? movementsOfCalls(calls, wallet) : null;
}

function batchData(intent: BridgeJ, wallet: Hex, fee: bigint): Hex {
  const router = routerOf(intent.source_chain_id).router;
  const selector = routerOf(intent.dest_chain_id).selector;
  const calls: Execution[] = [
    {
      target: intent.source_token_address,
      value: 0n,
      callData: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [router, BigInt(intent.amount.base_units)],
      }),
    },
    {
      target: router,
      value: fee,
      callData: encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'ccipSend',
        args: [selector, ccipMessage(intent, wallet)],
      }),
    },
  ];
  return encodeExecuteBatch(calls);
}

export const bridgeHandler: StepHandler<BridgeJ> = {
  chainOf: (intent) => intent.source_chain_id,

  async plan(ctx, intent) {
    const router = routerOf(intent.source_chain_id).router;
    const selector = routerOf(intent.dest_chain_id).selector;
    const message = ccipMessage(intent, ctx.walletAddress);
    // Quote the exact message that will be sent: a different one can underpay (F-3).
    const quoted = decodeFunctionResult({
      abi: ROUTER_ABI,
      functionName: 'getFee',
      data: await ctx.gateway.call(
        router,
        encodeFunctionData({ abi: ROUTER_ABI, functionName: 'getFee', args: [selector, message] }),
      ),
    });
    if (quoted > parseEther(intent.fee_max_eth)) {
      return finished({ status: 'failed', error_code: 'FEE_TOO_HIGH' });
    }
    // Saved before the send, so the wait can resume after a crash without a second bridge.
    const destBlock = (await ctx.gatewayFor(intent.dest_chain_id).latestBlock()).number;
    ctx.store.saveStepData(ctx.envelope.request_id, intent.step, {
      fee_wei: quoted.toString(),
      dest_from_block: destBlock,
    });

    const wallet = ctx.walletAddress;
    const data = batchData(intent, wallet, quoted);
    const amount = BigInt(intent.amount.base_units);
    const check: Check = {
      blocks: [{ calls: [{ from: wallet, to: wallet, data }], stateOverrides: asUpgraded(wallet) }],
      // A.5 rules 6, 7, 8: exact approval, exact fee, and the receiver is the user. The schema is the only other guard on the last.
      decode: () => decodeBridgeBatch(data, intent, wallet, quoted),
      movements: [
        { token: intent.source_token_address, from: wallet, to: null, value: amount },
        ...(quoted > 0n ? [{ token: ETH, from: wallet, to: router, value: quoted }] : []),
      ],
      events: [],
      summary: (decodeExecuteBatch(data) ?? []).map((c) =>
        describeCall(
          decodeCall(c),
          () => 6,
          () => 'USDC',
        ),
      ),
    };
    return { kind: 'check', check };
  },

  async prepare(ctx, intent) {
    const saved = ctx.store.stepData<{ fee_wei: string }>(ctx.envelope.request_id, intent.step);
    if (!saved) throw new Error('bridge quote missing');
    return {
      kind: 'tx',
      tx: { to: ctx.walletAddress, data: batchData(intent, ctx.walletAddress, BigInt(saved.fee_wei)) },
    };
  },

  async settled(ctx, intent, receipt, hash) {
    const amount = BigInt(intent.amount.base_units);
    const token = intent.source_token_address.toLowerCase();
    const wallet = ctx.walletAddress.toLowerCase();
    const debited = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs, strict: true }).some(
      (l) => l.address.toLowerCase() === token && l.args.from.toLowerCase() === wallet && l.args.value === amount,
    );
    const allowance = decodeFunctionResult({
      abi: erc20Abi,
      functionName: 'allowance',
      data: await ctx.gateway.call(
        intent.source_token_address,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: 'allowance',
          args: [ctx.walletAddress, routerOf(intent.source_chain_id).router],
        }),
      ),
    });
    if (!debited || allowance !== 0n) {
      return finished({ status: 'failed', tx_hash: hash, error_code: 'EFFECT_MISSING' });
    }
    const saved = ctx.store.stepData<Omit<WaitData, 'arrive_by_ms'>>(ctx.envelope.request_id, intent.step);
    const data: WaitData = {
      fee_wei: saved?.fee_wei ?? '0',
      dest_from_block: saved?.dest_from_block ?? 0,
      arrive_by_ms: ctx.now().getTime() + ctx.bridgeTimeoutMs,
    };
    return { kind: 'wait', data };
  },

  async poll(ctx, intent, raw, hash) {
    const data = raw as WaitData;
    const gateway = ctx.gatewayFor(intent.dest_chain_id);
    const latest = await gateway.latestBlock();
    const logs = await scanLogs(gateway, {
      address: intent.dest_token_address,
      event: TRANSFER_EVENT,
      args: { to: ctx.walletAddress },
      fromBlock: data.dest_from_block,
      toBlock: latest.number,
    });
    const report = { bridge_fee_eth: formatEther(BigInt(data.fee_wei)) };
    if (logs.some((l) => l.args.value === BigInt(intent.amount.base_units))) {
      return {
        status: 'executed',
        tx_hash: hash,
        executed_at: ctx.now().toISOString(),
        report,
      };
    }
    if (ctx.now().getTime() > data.arrive_by_ms) {
      return { status: 'failed', tx_hash: hash, error_code: 'BRIDGE_ARRIVAL_TIMEOUT', report };
    }
    return null;
  },
};
