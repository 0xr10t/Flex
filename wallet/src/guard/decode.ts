// The decoder: reads raw bytes, with no knowledge of how they were built, and says what they do. It works from what would really
// be signed or what a simulation really logged, so a bug in the code that built a batch can't hide here.

import {
  decodeAbiParameters,
  decodeFunctionData,
  erc20Abi,
  formatUnits,
  parseAbi,
  parseAbiParameters,
  parseEventLogs,
  type Hex,
  type Log,
} from 'viem';
import { DELEGATION, DELEGATION_MANAGER_ABI, EXECUTOR_ABI } from '../autopay/abi.js';
import type { Execution } from '../chain/redeem.v2.js';

export const ETH = 'ETH' as const;

/** Money leaving or arriving. `to` is null when any receiver is fine, such as a bridge's token pool. */
export interface Movement {
  token: Hex | typeof ETH;
  from: Hex;
  to: Hex | null;
  value: bigint;
}

const EXECUTE_ABI = parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']);

const ROUTER_ABI = parseAbi([
  'struct TokenAmount { address token; uint256 amount; }',
  'struct Message { bytes receiver; bytes data; TokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }',
  'function ccipSend(uint64 destSelector, Message message) payable returns (bytes32)',
]);

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

const BATCH_DEFAULT = `0x01${'00'.repeat(31)}`;

export function decodeExecuteBatch(data: Hex): Execution[] | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: EXECUTE_ABI, data });
    if (functionName !== 'execute' || args[0] !== BATCH_DEFAULT) return null;
    return [...decodeAbiParameters(EXECUTIONS, args[1])[0]] as Execution[];
  } catch {
    return null;
  }
}

const SINGLE_DEFAULT = `0x${'00'.repeat(32)}`;
const DELEGATIONS = parseAbiParameters(`${DELEGATION}[]`);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** An ERC-7579 single execution: target (20 bytes) ‖ value (32 bytes) ‖ calldata. */
const unpackSingle = (packed: Hex): Execution | null =>
  packed.length < 106
    ? null
    : {
        target: `0x${packed.slice(2, 42)}`,
        value: BigInt(`0x${packed.slice(42, 106)}`),
        callData: `0x${packed.slice(106)}`,
      };

/**
 * The calls inside a `redeemDelegations` call: what a run would actually do. Either one batch, or one single execution
 * per entry under the same context (a MetaMask permission, F8).
 */
export function decodeRedeemBatch(redeem: Hex): Execution[] | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: DELEGATION_MANAGER_ABI, data: redeem });
    if (functionName !== 'redeemDelegations') return null;
    const [contexts, modes, executions] = args as readonly [readonly Hex[], readonly Hex[], readonly Hex[]];
    if (modes.length === 1 && executions.length === 1 && modes[0] === BATCH_DEFAULT)
      return [...decodeAbiParameters(EXECUTIONS, executions[0] as Hex)[0]] as Execution[];
    if (
      !executions.length ||
      contexts.length !== executions.length ||
      modes.length !== executions.length ||
      contexts.some((c) => c !== contexts[0]) ||
      modes.some((m) => m !== SINGLE_DEFAULT)
    )
      return null;
    const calls = executions.map(unpackSingle);
    return calls.every((c) => c !== null) ? (calls as Execution[]) : null;
  } catch {
    return null;
  }
}

/**
 * The calls the account itself ran in a mined transaction, or null. MetaMask either sends from the account, or pays the
 * gas itself: a relayer then redeems the account's own delegation, and the DelegationManager runs the call as the
 * account (its root delegator). A call to the account is unwrapped from its `execute` batch. The receipt's status is
 * checked separately.
 */
export function executedCalls(
  tx: { from: Hex; to: Hex; data: Hex; value: bigint },
  wallet: Hex,
  manager: Hex,
): Execution[] | null {
  let call: Execution;
  if (same(tx.from, wallet)) call = { target: tx.to, value: tx.value, callData: tx.data };
  else {
    if (!same(tx.to, manager) || tx.value !== 0n) return null;
    try {
      const { functionName, args } = decodeFunctionData({ abi: DELEGATION_MANAGER_ABI, data: tx.data });
      if (functionName !== 'redeemDelegations') return null;
      const [contexts, modes, executions] = args as readonly [readonly Hex[], readonly Hex[], readonly Hex[]];
      if (contexts.length !== 1 || modes.length !== 1 || executions.length !== 1) return null;
      const chain = decodeAbiParameters(DELEGATIONS, contexts[0]!)[0];
      if (!chain.length || !same(chain[chain.length - 1]!.delegator, wallet)) return null;
      if (modes[0] === BATCH_DEFAULT) return [...decodeAbiParameters(EXECUTIONS, executions[0]!)[0]] as Execution[];
      const single = modes[0] === SINGLE_DEFAULT ? unpackSingle(executions[0]!) : null;
      if (!single) return null;
      call = single;
    } catch {
      return null;
    }
  }
  if (!same(call.target, wallet)) return [call];
  return call.value === 0n ? decodeExecuteBatch(call.callData) : null;
}

/** One call in a batch, in plain terms. Anything not recognised is `unknown`, which never matches an intent. */
export type DecodedCall =
  | { kind: 'eth'; to: Hex; value: bigint }
  | { kind: 'transfer'; token: Hex; to: Hex; value: bigint }
  | { kind: 'approve'; token: Hex; spender: Hex; value: bigint }
  | {
      kind: 'ccipSend';
      router: Hex;
      fee: bigint;
      selector: bigint;
      receiver: Hex;
      token: Hex;
      value: bigint;
      feeToken: Hex;
      data: Hex;
    }
  | { kind: 'cancel'; executor: Hex; planId: Hex }
  | { kind: 'disableDelegation'; manager: Hex; delegator: Hex; delegate: Hex }
  | { kind: 'unknown'; target: Hex };

export function decodeCall(call: Execution): DecodedCall {
  const { target, value, callData } = call;
  if (callData === '0x') return { kind: 'eth', to: target, value };
  try {
    const d = decodeFunctionData({ abi: erc20Abi, data: callData });
    if (value === 0n && d.functionName === 'transfer') {
      const [to, amount] = d.args;
      return { kind: 'transfer', token: target, to, value: amount };
    }
    if (value === 0n && d.functionName === 'approve') {
      const [spender, amount] = d.args;
      return { kind: 'approve', token: target, spender, value: amount };
    }
  } catch {
    // Not a token call.
  }
  try {
    const d = decodeFunctionData({ abi: ROUTER_ABI, data: callData });
    if (d.functionName === 'ccipSend') {
      const [selector, message] = d.args;
      const [receiver] = decodeAbiParameters([{ type: 'address' }], message.receiver);
      const only = message.tokenAmounts.length === 1 ? message.tokenAmounts[0] : undefined;
      if (only) {
        return {
          kind: 'ccipSend',
          router: target,
          fee: value,
          selector,
          receiver,
          token: only.token,
          value: only.amount,
          feeToken: message.feeToken,
          data: message.data,
        };
      }
    }
  } catch {
    // Not a bridge call.
  }
  if (value === 0n) {
    try {
      const d = decodeFunctionData({ abi: EXECUTOR_ABI, data: callData });
      if (d.functionName === 'cancel') return { kind: 'cancel', executor: target, planId: d.args[0] };
    } catch {
      // Not an executor call.
    }
    try {
      const d = decodeFunctionData({ abi: DELEGATION_MANAGER_ABI, data: callData });
      if (d.functionName === 'disableDelegation') {
        const [delegation] = d.args as readonly [{ delegator: Hex; delegate: Hex }];
        return {
          kind: 'disableDelegation',
          manager: target,
          delegator: delegation.delegator,
          delegate: delegation.delegate,
        };
      }
    } catch {
      // Not a manager call.
    }
  }
  return { kind: 'unknown', target };
}

/** What a list of calls would move out of `from`. */
export function movementsOfCalls(calls: readonly DecodedCall[], from: Hex): Movement[] {
  const out: Movement[] = [];
  for (const c of calls) {
    if (c.kind === 'eth') out.push({ token: ETH, from, to: c.to, value: c.value });
    if (c.kind === 'transfer') out.push({ token: c.token, from, to: c.to, value: c.value });
    if (c.kind === 'ccipSend') {
      out.push({ token: c.token, from, to: null, value: c.value });
      if (c.fee > 0n) out.push({ token: ETH, from, to: c.router, value: c.fee });
    }
  }
  return out;
}

// `traceTransfers` logs each ETH move as a Transfer from a made-up address, and providers differ on which: 0xfff…fffe on Sepolia's
// node here, 0xeee…eeee on Base Sepolia's and Arbitrum Sepolia's. Tested on all three.
const ETH_LOG_ADDRESSES = new Set([
  '0xfffffffffffffffffffffffffffffffffffffffe',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
]);

/** What simulated or real logs say moved. */
export function movementsOfLogs(logs: readonly Log[]): Movement[] {
  return parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: logs as Log[], strict: true }).map((l) => ({
    token: ETH_LOG_ADDRESSES.has(l.address.toLowerCase()) ? ETH : (l.address as Hex),
    from: l.args.from,
    to: l.args.to,
    value: l.args.value,
  }));
}

export interface SeenEvent {
  name: string;
  planId?: Hex;
  address: Hex;
}

export function eventsOfLogs(logs: readonly Log[]): SeenEvent[] {
  const list = logs as Log[];
  return [
    ...parseEventLogs({ abi: EXECUTOR_ABI, logs: list, strict: true }).map((l) => ({
      name: l.eventName as string,
      planId: l.args.intentId,
      address: l.address as Hex,
    })),
    ...parseEventLogs({ abi: DELEGATION_MANAGER_ABI, logs: list, strict: true, eventName: 'DisabledDelegation' }).map(
      (l) => ({
        name: l.eventName as string,
        address: l.address as Hex,
      }),
    ),
  ];
}

const short = (a: Hex) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A readable line for one call, for the user to check. Stays on this machine: it's never logged or reported. */
export function describeCall(
  call: DecodedCall,
  decimalsOf: (token: Hex) => number,
  symbolOf: (token: Hex) => string,
): string {
  switch (call.kind) {
    case 'eth':
      return `Send ${formatUnits(call.value, 18)} ETH to ${short(call.to)}`;
    case 'transfer':
      return `Send ${formatUnits(call.value, decimalsOf(call.token))} ${symbolOf(call.token)} to ${short(call.to)}`;
    case 'approve':
      return `Allow ${short(call.spender)} to take exactly ${formatUnits(call.value, decimalsOf(call.token))} ${symbolOf(call.token)}`;
    case 'ccipSend':
      return `Bridge ${formatUnits(call.value, decimalsOf(call.token))} ${symbolOf(call.token)} to your own address (${short(call.receiver)}), with a network fee of ${formatUnits(call.fee, 18)} ETH`;
    case 'cancel':
      return `Stop autopay ${short(call.planId)}`;
    case 'disableDelegation':
      return `Disable the permission you signed for ${short(call.delegate)}`;
    case 'unknown':
      return `Unrecognised call to ${short(call.target)}`;
  }
}
