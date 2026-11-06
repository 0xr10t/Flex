// Your redeem.ts, corrected: ERC-20 payments become token.transfer calls [B1], and the
// per-run fee is part of the same signed batch [B8]. Still viem-only, so it runs inside CRE WASM.
// Keep always-batch encoding even for one recipient: the MetaMask kit encodes a single execution
// differently and the batch delegation rejects it [B10], while this encoder works [B10b].
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  parseUnits,
  type Hex,
} from 'viem';
import type { Intent } from '@flex/protocol/schemas/intent.v2';

export type SignedDelegation = {
  delegate: Hex;
  delegator: Hex;
  authority: Hex;
  caveats: { enforcer: Hex; terms: Hex; args: Hex }[];
  salt: string;
  signature: Hex;
};
export type Execution = { target: Hex; value: bigint; callData: Hex };

const DELEGATION = {
  type: 'tuple[]',
  components: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    {
      name: 'caveats',
      type: 'tuple[]',
      components: [
        { name: 'enforcer', type: 'address' },
        { name: 'terms', type: 'bytes' },
        { name: 'args', type: 'bytes' },
      ],
    },
    { name: 'salt', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ],
} as const;
const EXECUTIONS = {
  type: 'tuple[]',
  components: [
    { name: 'target', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'callData', type: 'bytes' },
  ],
} as const;
const REDEEM_ABI = [
  {
    type: 'function',
    name: 'redeemDelegations',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_permissionContexts', type: 'bytes[]' },
      { name: '_modes', type: 'bytes32[]' },
      { name: '_executionCallDatas', type: 'bytes[]' },
    ],
    outputs: [],
  },
] as const;
const BATCH_DEFAULT = '0x0100000000000000000000000000000000000000000000000000000000000000' as const;

/** Read the same single-delegation shape accepted by IntentExecutorV3, without loading a signer. */
export function redeemIdentity(redeem: Hex): { delegator: Hex; delegate: Hex } {
  const {
    args: [contexts, modes, executions],
  } = decodeFunctionData({ abi: REDEEM_ABI, data: redeem });
  if (contexts.length !== 1 || modes.length !== 1 || executions.length !== 1 || modes[0] !== BATCH_DEFAULT)
    throw new Error('INVALID_REDEEM');
  const [delegations] = decodeAbiParameters([DELEGATION], contexts[0]!);
  if (delegations.length !== 1) throw new Error('INVALID_REDEEM');
  return { delegator: delegations[0]!.delegator, delegate: delegations[0]!.delegate };
}

const pay = (i: Intent, to: Hex, amount: string): Execution => {
  const units = parseUnits(amount, i.asset.decimals);
  return i.asset.type === 'native'
    ? { target: to, value: units, callData: '0x' }
    : {
        target: i.asset.token as Hex,
        value: 0n,
        callData: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, units] }),
      };
};

/** Every recipient, then the fee, in one all-or-nothing batch. The delegation must sign exactly this list. */
export const executionsOf = (i: Intent): Execution[] => [
  ...i.recipients.map((r) => pay(i, r.to as Hex, r.amount)),
  ...(i.execution.fee ? [pay(i, i.execution.fee.to as Hex, i.execution.fee.amount)] : []),
];

export function redeemCalldata(intent: Intent, d: SignedDelegation): Hex {
  const ctx = encodeAbiParameters([DELEGATION], [[{ ...d, salt: BigInt(d.salt) }]]);
  const exec = encodeAbiParameters([EXECUTIONS], [executionsOf(intent)]);
  return encodeFunctionData({
    abi: REDEEM_ABI,
    functionName: 'redeemDelegations',
    args: [[ctx], [BATCH_DEFAULT], [exec]],
  });
}
