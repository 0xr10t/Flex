// What MetaMask answers to `wallet_requestExecutionPermissions`, built with MetaMask's own caveat code rather than the
// wallet's, so a disagreement between the two shows up in tests. The test signs as the account, the way MetaMask would.
import { createErc20TokenPeriodicCaveats, createNativeTokenPeriodicCaveats } from '@metamask/7715-permission-types';
import { createNonceTerms, createTimestampTerms } from '@metamask/delegation-core';
import { ROOT_AUTHORITY, type SmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { SIGNABLE_DELEGATION_TYPED_DATA } from '@metamask/smart-accounts-kit/utils';
import { encodeAbiParameters, parseAbiParameters, type Hex } from 'viem';
import { DELEGATION } from '../../src/autopay/abi.js';
import type { PermissionRequest } from '../../src/autopay/permission.js';

export type Caveat = { enforcer: Hex; terms: Hex; args: Hex };
export interface GrantOptions {
  caveats?: (caveats: Caveat[]) => Caveat[];
  delegation?: { delegate?: Hex; delegator?: Hex; authority?: Hex; salt?: bigint };
  response?: Record<string, unknown>;
}

export async function metamaskGrant(
  request: PermissionRequest,
  env: SmartAccountsEnvironment,
  sign: (typedData: never) => Promise<Hex>,
  o: GrantOptions = {},
) {
  const e = env.caveatEnforcers as Record<string, Hex>;
  const permission = request.permission as never;
  const base =
    request.permission.type === 'erc20-token-periodic'
      ? createErc20TokenPeriodicCaveats({
          permission,
          contracts: {
            erc20PeriodTransferEnforcer: e.ERC20PeriodTransferEnforcer!,
            valueLteEnforcer: e.ValueLteEnforcer!,
          },
        })
      : createNativeTokenPeriodicCaveats({
          permission,
          contracts: {
            nativeTokenPeriodTransferEnforcer: e.NativeTokenPeriodTransferEnforcer!,
            exactCalldataEnforcer: e.ExactCalldataEnforcer!,
          },
        });
  const caveats = (o.caveats ?? ((c) => c))([
    ...(base as Caveat[]),
    {
      enforcer: e.TimestampEnforcer!,
      terms: createTimestampTerms({ afterThreshold: 0, beforeThreshold: request.rules[0].data.timestamp }),
      args: '0x',
    },
    { enforcer: e.NonceEnforcer!, terms: createNonceTerms({ nonce: '0x00' }), args: '0x' },
  ]);
  const message = {
    delegate: request.to,
    delegator: request.from,
    authority: ROOT_AUTHORITY as Hex,
    caveats,
    salt: 7n,
    ...o.delegation,
  };
  const signature = await sign({
    domain: {
      name: 'DelegationManager',
      version: '1',
      chainId: Number(request.chainId),
      verifyingContract: env.DelegationManager,
    },
    types: SIGNABLE_DELEGATION_TYPED_DATA,
    primaryType: 'Delegation',
    message,
  } as never);
  return {
    chainId: request.chainId,
    from: request.from,
    to: request.to,
    permission: request.permission,
    rules: request.rules,
    context: encodeAbiParameters(parseAbiParameters(`${DELEGATION}[]`), [[{ ...message, signature }]]),
    dependencies: [],
    delegationManager: env.DelegationManager,
    ...o.response,
  };
}
