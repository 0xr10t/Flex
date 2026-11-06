// Implements: §9.2 steps 1–3 (address format, EIP-55 checksum, zero address, self-payment check),
// §13.4 "Address answers go through §9.2 step 1".

import { getAddress, isAddress } from 'viem';
import type { Address } from '../contracts/types.js';

/** §9.2 step 1 format. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = '0x0000000000000000000000000000000000000000';

export type AddressCheck =
  | { ok: true; address: Address }
  /** format: not `^0x[0-9a-fA-F]{40}$`; checksum: mixed case with an invalid EIP-55 checksum; zero: the zero address. */
  | { ok: false; reason: 'format' | 'checksum' | 'zero' };

/**
 * §9.2 steps 1–2. Mixed case must carry a valid EIP-55 checksum; all-lowercase or all-uppercase hex is accepted
 * and checksummed. The zero address is rejected.
 */
export function checkAddress(text: string): AddressCheck {
  const t = text.trim();
  if (!ADDRESS_RE.test(t)) return { ok: false, reason: 'format' };
  const hex = t.slice(2);
  const singleCase = hex === hex.toLowerCase() || hex === hex.toUpperCase();
  if (!singleCase && !isAddress(t, { strict: true })) return { ok: false, reason: 'checksum' };
  const address = getAddress(`0x${hex.toLowerCase()}`) as Address;
  if (address.toLowerCase() === ZERO) return { ok: false, reason: 'zero' };
  return { ok: true, address };
}

/** True when the text has the shape of an address (`0x` + 40 hex), whatever its checksum. */
export function looksLikeAddress(text: string): boolean {
  return ADDRESS_RE.test(text.trim());
}

/** Same address, whatever the case of the hex. */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** §9.2 step 3: equal to wallet.address. */
export function isSelf(address: string, wallet: string): boolean {
  return sameAddress(address, wallet);
}
