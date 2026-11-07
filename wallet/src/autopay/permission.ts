// F8: in browser mode a recurring plan runs under one MetaMask (ERC-7715) periodic permission instead of a delegation
// the user signs. It caps the token per period and expires after the last run; the executor pins who is paid, because
// it only replays the exact redeem the user's own account registered. MetaMask builds the caveats itself, so its answer
// is untrusted: it is accepted only when its delegation grants exactly what was asked, to exactly the executor.

import { ROOT_AUTHORITY, type SmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { createCaveatBuilder } from '@metamask/smart-accounts-kit/utils';
import { decodeAbiParameters, numberToHex, parseAbiParameters, type Hex } from 'viem';
import type { AutopayK } from '@flex/protocol/schemas/envelope';
import { DELEGATION } from './abi.js';

/** The `wallet_requestExecutionPermissions` entry for one plan. Plain JSON: it is stored and sent as is. */
export interface PermissionRequest {
  chainId: Hex;
  from: Hex;
  to: Hex;
  permission: {
    type: 'erc20-token-periodic' | 'native-token-periodic';
    isAdjustmentAllowed: false;
    data: { tokenAddress?: Hex; periodAmount: Hex; periodDuration: number; startTime: number; justification: string };
  };
  rules: [{ type: 'expiry'; data: { timestamp: number } }];
}

export class PermissionError extends Error {}

/** One period per run: each run's total, from its start, until one second after the last run's window closes. */
export function permissionRequestFor(intent: AutopayK, wallet: Hex, executor: Hex): PermissionRequest {
  const s = intent.schedule;
  const perRun = intent.recipients.reduce(
    (sum, r) => sum + BigInt(r.amount.base_units),
    BigInt(intent.fee.amount.base_units),
  );
  return {
    chainId: numberToHex(intent.chain_id),
    from: wallet,
    to: executor,
    permission: {
      type: intent.token === 'ETH' ? 'native-token-periodic' : 'erc20-token-periodic',
      isAdjustmentAllowed: false,
      data: {
        ...(intent.token === 'ETH' ? {} : { tokenAddress: intent.token_address as Hex }),
        periodAmount: numberToHex(perRun),
        periodDuration: s.interval_seconds,
        startTime: s.start_at,
        justification: `Flex autopay ${intent.autopay_id}: ${s.max_runs} runs to the recipients you approved.`,
      },
    },
    // The enforcer's bound is exclusive, so the last run's last second stays inside it.
    rules: [
      {
        type: 'expiry',
        data: { timestamp: s.start_at + (s.max_runs - 1) * s.interval_seconds + s.late_window_seconds + 1 },
      },
    ],
  };
}

/** The caveats MetaMask must have built for `request`, except its Nonce, whose value is the account's own. */
function expectedCaveats(request: PermissionRequest, env: SmartAccountsEnvironment) {
  const { data } = request.permission;
  const period = {
    periodAmount: BigInt(data.periodAmount),
    periodDuration: data.periodDuration,
    startDate: data.startTime,
  };
  const builder = createCaveatBuilder(env);
  if (request.permission.type === 'erc20-token-periodic')
    builder
      .addCaveat('erc20PeriodTransfer', { tokenAddress: data.tokenAddress as Hex, ...period })
      .addCaveat('valueLte', { maxValue: 0n });
  else builder.addCaveat('nativeTokenPeriodTransfer', period).addCaveat('exactCalldata', { calldata: '0x' });
  return builder
    .addCaveat('timestamp', { afterThreshold: 0, beforeThreshold: request.rules[0].data.timestamp })
    .build();
}

const DELEGATIONS = parseAbiParameters(`${DELEGATION}[]`);
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** Returns the permission context when MetaMask's response grants exactly `request`; throws a PermissionError otherwise. */
export function verifyGrant(request: PermissionRequest, response: unknown, env: SmartAccountsEnvironment): Hex {
  const mismatch = new PermissionError('PERMISSION_MISMATCH');
  const r = response as { chainId?: unknown; context?: unknown; dependencies?: unknown; delegationManager?: unknown };
  if (!r || typeof r !== 'object' || typeof r.context !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(r.context))
    throw mismatch;
  if (!Array.isArray(r.dependencies)) throw mismatch;
  // A counterfactual account would need its deployment first; out of scope.
  if (r.dependencies.length) throw new PermissionError('PERMISSION_UNSUPPORTED_ACCOUNT');
  if (!same(r.chainId, request.chainId) || !same(r.delegationManager, env.DelegationManager)) throw mismatch;
  let chain;
  try {
    [chain] = decodeAbiParameters(DELEGATIONS, r.context as Hex);
  } catch {
    throw mismatch;
  }
  const [d] = chain;
  if (
    chain.length !== 1 ||
    !d ||
    !same(d.delegator, request.from) ||
    !same(d.delegate, request.to) ||
    !same(d.authority, ROOT_AUTHORITY)
  )
    throw mismatch;
  const nonce = env.caveatEnforcers.NonceEnforcer!;
  const rest = d.caveats.filter((c) => !same(c.enforcer, nonce));
  const key = (c: { enforcer: string; terms: string }) => `${c.enforcer}:${c.terms}`.toLowerCase();
  const got = rest.map(key).sort().join();
  if (d.caveats.length - rest.length !== 1 || got !== expectedCaveats(request, env).map(key).sort().join())
    throw mismatch;
  return r.context as Hex;
}
