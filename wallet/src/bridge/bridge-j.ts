// Implements: §14.2 rule 4, Appendix A.3 `j`, A.4, A.5 rules 6-8. One batch: approve exactly the amount, then ccipSend with exactly
// the quoted fee (the router keeps any overpayment), always to the user's own address. A dependent step starts only once the
// USDC has arrived.
//
// Delivery is tied to the exact CCIP 2.0 message and finalized destination execution. A timeout only marks a delay.

import {
  concat,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  getAbiItem,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  type Hex,
} from 'viem';
import { scanLogs } from '../autopay/scan.js';
import { ChainUnavailableError, type TxReceipt } from '../chain/gateway.js';
import type { Execution } from '../chain/redeem.v2.js';
import { asUpgraded, type Check } from '../guard/check.js';
import { ETH, decodeCall, decodeExecuteBatch, describeCall, movementsOfCalls, type Movement } from '../guard/decode.js';
import { encodeExecuteBatch } from '../payments/payment-i.js';
import { finished, type HandlerContext, type StepHandler } from '../runner/handler.js';
import { CCIP } from '@flex/protocol/schemas/bridge.v2';
import type { BridgeJ, ChainId } from '@flex/protocol/schemas/envelope';
import { CCIP_V2_EVENTS } from './ccip-v2-abi.js';
import { decodeTokenMessage } from './message-v1.js';

const ROUTER_ABI = parseAbi([
  'struct TokenAmount { address token; uint256 amount; }',
  'struct Message { bytes receiver; bytes data; TokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }',
  'function isChainSupported(uint64 destSelector) view returns (bool)',
  'function getOnRamp(uint64 destSelector) view returns (address)',
  'function isOffRamp(uint64 sourceSelector, address offRamp) view returns (bool)',
  'function typeAndVersion() view returns (string)',
  'function getFee(uint64 destSelector, Message message) view returns (uint256)',
  'function ccipSend(uint64 destSelector, Message message) payable returns (bytes32)',
]);

const EXECUTION_EVENT = getAbiItem({ abi: CCIP_V2_EVENTS, name: 'ExecutionStateChanged' });

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
  dest_scan_next?: number;
  arrive_by_ms: number;
  on_ramp: Hex;
  message?: TrackedMessage;
  tracking_status?: string;
  destination_tx_hash?: Hex;
  observed_destination_tx_hash?: Hex;
  destination_observe_next?: number;
  failure_data?: Hex;
  delayed?: boolean;
}

interface TrackedMessage {
  message_id: Hex;
  message_number: string;
  source_selector: string;
  dest_selector: string;
  on_ramp: Hex;
  off_ramp: Hex;
  source_token: Hex;
  dest_token: Hex;
  amount: string;
  receiver: Hex;
}

function hasDestinationTransfer(receipt: TxReceipt, message: TrackedMessage): boolean {
  return parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs, strict: true }).some(
    (e) =>
      e.address.toLowerCase() === message.dest_token.toLowerCase() &&
      e.args.to.toLowerCase() === message.receiver.toLowerCase() &&
      e.args.value === BigInt(message.amount),
  );
}

/** Provisional UI observation only. It cannot complete the step, emit a success report or unlock a payment. */
async function observeDestination(ctx: HandlerContext, intent: BridgeJ, data: WaitData, message: TrackedMessage) {
  const gateway = ctx.gatewayFor(intent.dest_chain_id);
  const save = () => ctx.store.saveStepData(ctx.envelope.request_id, intent.step, data);
  const delivered = (receipt: TxReceipt | null) =>
    receipt?.status === 'success' &&
    hasDestinationTransfer(receipt, message) &&
    parseEventLogs({
      abi: CCIP_V2_EVENTS,
      eventName: 'ExecutionStateChanged',
      logs: receipt.logs,
      strict: true,
    }).some(
      (e) =>
        e.address.toLowerCase() === message.off_ramp.toLowerCase() &&
        e.args.sourceChainSelector === BigInt(message.source_selector) &&
        e.args.messageNumber === BigInt(message.message_number) &&
        e.args.messageId === message.message_id &&
        e.args.state === 2,
    );
  if (data.observed_destination_tx_hash) {
    if (delivered(await gateway.getReceipt(data.observed_destination_tx_hash))) return;
    // An unfinalized observation can disappear in a reorg. Resume discovery without reporting success.
    delete data.observed_destination_tx_hash;
    data.destination_observe_next = data.dest_from_block;
    if (data.tracking_status === 'destination_unfinalized') data.tracking_status = 'in_transit';
    save();
  }
  const head = await gateway.latestBlock();
  const fromBlock = data.destination_observe_next ?? data.dest_from_block;
  if (head.number < fromBlock) return;
  const logs = await scanLogs(gateway, {
    address: message.off_ramp,
    event: EXECUTION_EVENT,
    args: { sourceChainSelector: BigInt(message.source_selector), messageId: message.message_id },
    fromBlock,
    toBlock: head.number,
  });
  for (const log of logs) {
    if (log.args.state !== 2 || log.args.messageNumber !== BigInt(message.message_number)) continue;
    if (delivered(await gateway.getReceipt(log.transactionHash))) {
      data.observed_destination_tx_hash = log.transactionHash;
      data.tracking_status = 'destination_unfinalized';
      save();
      return;
    }
  }
  // Small overlap catches recent reorgs; the independent finalized scan covers the entire canonical history.
  data.destination_observe_next = Math.max(data.dest_from_block, head.number - 64);
  save();
}

/** The OnRamp must be the one discovered through the source Router before signing. */
export function trackedMessage(receipt: TxReceipt, intent: BridgeJ, wallet: Hex, onRamp: Hex): TrackedMessage | null {
  try {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const events = parseEventLogs({
      abi: CCIP_V2_EVENTS,
      eventName: 'CCIPMessageSent',
      logs: receipt.logs,
      strict: true,
    }).filter((e) => same(e.address, onRamp));
    if (events.length !== 1) return null;
    const { messageId, destChainSelector, sender, tokenAmountBeforeTokenPoolFees, encodedMessage } = events[0]!.args;
    const m = decodeTokenMessage(encodedMessage);
    const amount = BigInt(intent.amount.base_units);
    if (
      messageId !== keccak256(encodedMessage) ||
      destChainSelector !== CCIP[intent.dest_chain_id].selector ||
      !same(sender, wallet) ||
      tokenAmountBeforeTokenPoolFees !== amount ||
      m.sourceSelector !== CCIP[intent.source_chain_id].selector ||
      m.destSelector !== destChainSelector ||
      !same(m.onRamp, onRamp) ||
      !same(m.sender, wallet) ||
      !same(m.receiver, wallet) ||
      (m.tokenReceiver !== '0x' && !same(m.tokenReceiver, wallet)) ||
      !same(m.sourceToken, intent.source_token_address) ||
      !same(m.destToken, intent.dest_token_address) ||
      m.amount !== amount ||
      m.finality !== 0n ||
      m.receiveGasLimit !== 0n ||
      m.data !== '0x' ||
      !parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs, strict: true }).some(
        (e) => same(e.address, intent.source_token_address) && same(e.args.from, wallet) && e.args.value === amount,
      )
    )
      return null;
    return {
      message_id: messageId,
      message_number: m.messageNumber.toString(),
      source_selector: m.sourceSelector.toString(),
      dest_selector: m.destSelector.toString(),
      on_ramp: onRamp,
      off_ramp: m.offRamp,
      source_token: m.sourceToken,
      dest_token: m.destToken,
      amount: m.amount.toString(),
      receiver: wallet,
    };
  } catch {
    return null;
  }
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
    const supported = decodeFunctionResult({
      abi: ROUTER_ABI,
      functionName: 'isChainSupported',
      data: await ctx.gateway.call(
        router,
        encodeFunctionData({ abi: ROUTER_ABI, functionName: 'isChainSupported', args: [selector] }),
      ),
    });
    if (!supported) return finished({ status: 'failed', error_code: 'BRIDGE_ROUTE_UNAVAILABLE' });
    // Quote the exact message that will be sent: a different one can underpay (F-3).
    const quoted = decodeFunctionResult({
      abi: ROUTER_ABI,
      functionName: 'getFee',
      data: await ctx.gateway.call(
        router,
        encodeFunctionData({ abi: ROUTER_ABI, functionName: 'getFee', args: [selector, message] }),
      ),
    });
    if (quoted > parseEther(intent.fee_max_eth) || quoted > parseEther(ctx.bridgeFeeMaxEth ?? '0.003')) {
      return finished({ status: 'failed', error_code: 'FEE_TOO_HIGH' });
    }
    const onRamp = decodeFunctionResult({
      abi: ROUTER_ABI,
      functionName: 'getOnRamp',
      data: await ctx.gateway.call(
        router,
        encodeFunctionData({ abi: ROUTER_ABI, functionName: 'getOnRamp', args: [selector] }),
      ),
    });
    const version = decodeFunctionResult({
      abi: ROUTER_ABI,
      functionName: 'typeAndVersion',
      data: await ctx.gateway.call(onRamp, encodeFunctionData({ abi: ROUTER_ABI, functionName: 'typeAndVersion' })),
    });
    if (version !== 'OnRamp 2.0.0') return finished({ status: 'failed', error_code: 'BRIDGE_VERSION_UNSUPPORTED' });
    // Saved before the send, so the wait can resume after a crash without a second bridge.
    const destBlock = (await ctx.gatewayFor(intent.dest_chain_id).latestBlock()).number;
    ctx.store.saveStepData(ctx.envelope.request_id, intent.step, {
      fee_wei: quoted.toString(),
      dest_from_block: destBlock,
      on_ramp: onRamp,
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
    const saved = ctx.store.stepData<Omit<WaitData, 'arrive_by_ms'>>(ctx.envelope.request_id, intent.step);
    if (!saved?.on_ramp) throw new ChainUnavailableError();
    const message = trackedMessage(receipt, intent, ctx.walletAddress, saved.on_ramp);
    const data: WaitData = {
      ...saved,
      arrive_by_ms: ctx.now().getTime() + ctx.bridgeTimeoutMs,
      ...(message ? { message } : {}),
      tracking_status: message ? 'source_unfinalized' : 'source_message_unverified',
    };
    void hash; // The runner durably retains the source hash on the step.
    return { kind: 'wait', data };
  },

  async poll(ctx, intent, raw, hash) {
    const data = raw as WaitData;
    const save = () => ctx.store.saveStepData(ctx.envelope.request_id, intent.step, data);
    if (ctx.now().getTime() > data.arrive_by_ms && !data.delayed) {
      data.delayed = true;
      save();
    }
    const source = await ctx.gateway.getFinalizedReceipt(hash);
    if (!source) return null;
    if (source.status === 'reverted') return { status: 'failed', tx_hash: hash, error_code: 'TX_REVERTED' };
    const message = trackedMessage(source, intent, ctx.walletAddress, data.on_ramp);
    if (!message) {
      data.tracking_status = 'source_message_unverified';
      save();
      return null;
    }
    // Re-read the canonical source receipt: a source reorg may have changed the message number/hash.
    if (data.message?.message_id !== message.message_id) data.dest_scan_next = data.dest_from_block;
    data.message = message;
    const gateway = ctx.gatewayFor(intent.dest_chain_id);
    const trustedRamp = decodeFunctionResult({
      abi: ROUTER_ABI,
      functionName: 'isOffRamp',
      data: await gateway.call(
        routerOf(intent.dest_chain_id).router,
        encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: 'isOffRamp',
          args: [BigInt(message.source_selector), message.off_ramp],
        }),
      ),
    });
    if (!trustedRamp) {
      data.tracking_status = 'destination_ramp_unverified';
      save();
      return null;
    }
    // Source finality may arrive long before the destination's finalized head reaches our scan start.
    // Keep the displayed stage accurate even when there is no destination range to scan yet.
    if (
      !data.tracking_status ||
      ['source_unfinalized', 'source_message_unverified', 'destination_ramp_unverified'].includes(data.tracking_status)
    ) {
      data.tracking_status = 'in_transit';
      save();
    }
    await observeDestination(ctx, intent, data, message);
    const latest = await gateway.finalizedBlock();
    const fromBlock = data.dest_scan_next ?? data.dest_from_block;
    if (latest.number < fromBlock) return null;
    const logs = await scanLogs(gateway, {
      address: message.off_ramp,
      event: EXECUTION_EVENT,
      args: { sourceChainSelector: BigInt(message.source_selector), messageId: message.message_id },
      fromBlock,
      toBlock: latest.number,
    });
    const report = { bridge_fee_eth: formatEther(BigInt(data.fee_wei)) };
    for (const log of logs) {
      if (log.args.messageId !== message.message_id || log.args.messageNumber !== BigInt(message.message_number))
        continue;
      const receipt = await gateway.getFinalizedReceipt(log.transactionHash);
      if (!receipt || receipt.status !== 'success') return null;
      const exact = parseEventLogs({
        abi: CCIP_V2_EVENTS,
        eventName: 'ExecutionStateChanged',
        logs: receipt.logs,
        strict: true,
      }).find(
        (e) =>
          e.address.toLowerCase() === message.off_ramp.toLowerCase() &&
          e.args.messageId === message.message_id &&
          e.args.sourceChainSelector === BigInt(message.source_selector) &&
          e.args.messageNumber === BigInt(message.message_number) &&
          e.logIndex === log.logIndex,
      );
      if (!exact) return null;
      data.destination_tx_hash = log.transactionHash;
      if (exact.args.state === 2) {
        const delivered = hasDestinationTransfer(receipt, message);
        if (!delivered) {
          data.tracking_status = 'destination_effect_unverified';
          save();
          return null;
        }
        data.tracking_status = 'executed';
        save();
        return { status: 'executed', tx_hash: hash, executed_at: receipt.executedAt, report };
      }
      if (exact.args.state === 3) {
        data.tracking_status = 'destination_failed';
        data.failure_data = exact.args.returnData;
      }
    }
    data.dest_scan_next = latest.number + 1;
    if (!data.tracking_status || data.tracking_status === 'source_unfinalized') data.tracking_status = 'in_transit';
    save();
    return null;
  },
};
