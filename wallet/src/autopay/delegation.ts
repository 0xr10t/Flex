// Implements: §14.2 rule 5, Appendix A.3 `k` steps 1-2, A.5 rules 1-3. The user signs one delegation that allows exactly one
// batch, a limited number of times, in a time range, so whoever triggers a run can't change who gets paid or how much.
//
// Signing goes through `signTypedData`, not a raw key, so a wallet such as MetaMask can sign it instead.

import { ROOT_AUTHORITY, createExecution, type SmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import {
  SIGNABLE_DELEGATION_TYPED_DATA,
  createCaveatBuilder,
  hashDelegation,
} from '@metamask/smart-accounts-kit/utils';
import { decodeAbiParameters, decodeFunctionData, keccak256, type Hex } from 'viem';
import { executionsOf, redeemCalldata, type SignedDelegation } from '../chain/redeem.v2.js';
import { intentHash, type Intent } from '../schemas/intent.v2.js';
import { DELEGATION_MANAGER_ABI } from './abi.js';

export type { SignedDelegation };

export type SignTypedData = (typedData: {
  domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
  types: typeof SIGNABLE_DELEGATION_TYPED_DATA;
  primaryType: 'Delegation';
  message: Record<string, unknown>;
}) => Promise<Hex>;

export interface DelegationInput {
  intent: Intent;
  delegator: Hex;
  executor: Hex;
  chainId: number;
  env: SmartAccountsEnvironment;
  startAt: number;
  endAt: number;
}

/** OQ-10: every passing lab test used `start - 1`, and the enforcer's bounds are exclusive. See delegation tests. */
const timestampBounds = (startAt: number, endAt: number) => ({
  afterThreshold: startAt - 1,
  beforeThreshold: endAt + 1,
});

export async function signAutopayDelegation(input: DelegationInput, sign: SignTypedData): Promise<SignedDelegation> {
  const { intent, env } = input;
  const maxRuns = intent.schedule.maxRuns as number;
  const caveats = createCaveatBuilder(env)
    .addCaveat('exactExecutionBatch', { executions: executionsOf(intent).map((e) => createExecution(e)) })
    .addCaveat('limitedCalls', { limit: maxRuns })
    .addCaveat('timestamp', timestampBounds(input.startAt, input.endAt))
    .build();
  // The salt commits the signature to the whole intent, and is the same on a repeat (OQ-09).
  const salt = BigInt(intentHash(intent));
  const message = {
    delegate: input.executor,
    delegator: input.delegator,
    authority: ROOT_AUTHORITY as Hex,
    caveats,
    salt,
  };
  const signature = await sign({
    domain: {
      name: 'DelegationManager',
      version: '1',
      chainId: input.chainId,
      verifyingContract: env.DelegationManager as Hex,
    },
    types: SIGNABLE_DELEGATION_TYPED_DATA,
    primaryType: 'Delegation',
    message,
  });
  return {
    delegate: input.executor,
    delegator: input.delegator,
    authority: ROOT_AUTHORITY as Hex,
    caveats: caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
    salt: salt.toString(),
    signature,
  };
}

export const redeemFor = (intent: Intent, delegation: SignedDelegation): Hex => redeemCalldata(intent, delegation);

export const planIdOf = (redeem: Hex): Hex => keccak256(redeem);

const DELEGATION_ARRAY = [
  {
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
  },
] as const;

export interface DecodedDelegation {
  delegate: Hex;
  delegator: Hex;
  authority: Hex;
  caveats: readonly { enforcer: Hex; terms: Hex; args: Hex }[];
  salt: bigint;
  signature: Hex;
}

/** §12.5: reads the signed delegation back out of the redeem bytes a `Registered` event carries. */
export function delegationFromRedeem(redeem: Hex): DecodedDelegation | null {
  try {
    const { args } = decodeFunctionData({ abi: DELEGATION_MANAGER_ABI, data: redeem });
    if (args?.length !== 3) return null;
    const contexts = args[0] as readonly Hex[];
    if (contexts.length !== 1) return null;
    const [chain] = decodeAbiParameters(DELEGATION_ARRAY, contexts[0] as Hex);
    return chain.length === 1 ? (chain[0] as DecodedDelegation) : null;
  } catch {
    return null;
  }
}

export const delegationHash = (d: DecodedDelegation): Hex => hashDelegation(d as never);
