// Implements: Appendix A.1 (the user's account is an EOA upgraded with EIP-7702). OQ-19 (provisional): upgrade on first
// use on each chain, and refuse an account that already points at any other code, because a batch sent to self would run
// that code.

import type { Hex } from 'viem';
import { EIP7702_DELEGATOR, UPGRADED_CODE } from './addresses.js';
import type { ChainGateway } from './gateway.js';

export type UpgradeResult = 'ready' | 'ACCOUNT_DELEGATED_ELSEWHERE' | 'DELEGATOR_MISSING' | 'UPGRADE_FAILED';

const isEmpty = (code: Hex | undefined): boolean => code === undefined || code === '0x';

/** A read-only check, for before anything is signed. */
export async function accountProblem(
  gateway: ChainGateway,
  address: Hex,
): Promise<'ACCOUNT_DELEGATED_ELSEWHERE' | 'DELEGATOR_MISSING' | null> {
  const code = await gateway.getCode(address);
  if (code?.toLowerCase() === UPGRADED_CODE) return null;
  if (!isEmpty(code)) return 'ACCOUNT_DELEGATED_ELSEWHERE';
  return isEmpty(await gateway.getCode(EIP7702_DELEGATOR)) ? 'DELEGATOR_MISSING' : null;
}

export async function ensureUpgraded(gateway: ChainGateway, address: Hex): Promise<UpgradeResult> {
  const code = await gateway.getCode(address);
  if (code?.toLowerCase() === UPGRADED_CODE) return 'ready';
  if (!isEmpty(code)) return 'ACCOUNT_DELEGATED_ELSEWHERE';

  // Delegating to an address with no code would leave an account that accepts batches and does nothing.
  if (isEmpty(await gateway.getCode(EIP7702_DELEGATOR))) return 'DELEGATOR_MISSING';

  await gateway.sendUpgrade();
  const after = await gateway.getCode(address);
  return after?.toLowerCase() === UPGRADED_CODE ? 'ready' : 'UPGRADE_FAILED';
}
