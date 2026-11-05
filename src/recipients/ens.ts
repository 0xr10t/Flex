// Implements: §9.3 step 1 (ENSIP-15 normalise), §9.3 step 3 (per-chain lookup: coinType 60 for Sepolia,
// 0x80000000 | chainId for L2s per ENSIP-11, then the ENSIP-19 default EVM coin type 0x80000000; still null → no
// address on that chain), I-27. Coin types are bigint (JS bitwise on numbers would overflow to negative).

import { getAddress } from 'viem';
import { normalize } from 'viem/ens';
import type { EnsClient } from '../contracts/io.js';
import type { Address, ChainId, Config } from '../contracts/types.js';

/** ENSIP-19 default EVM coin type. */
export const DEFAULT_EVM_COIN_TYPE = 0x80000000n;
/** SLIP-44 coin type of Ethereum, used for Sepolia (§9.3 step 3). */
export const ETH_COIN_TYPE = 60n;

/** §9.3 step 3: 60 for the L1 (Sepolia), `0x80000000 | chainId` (ENSIP-11) for L2s. */
export function coinTypeFor(config: Config, chain_id: ChainId): bigint {
  const chain = config.chains.find((c) => c.chain_id === chain_id);
  const isL2 = chain ? chain.is_l2 : chain_id !== 11155111;
  return isL2 ? DEFAULT_EVM_COIN_TYPE | BigInt(chain_id) : ETH_COIN_TYPE;
}

/** §9.3 step 1: ENSIP-15 normalise; null on failure. */
export function normalizeEns(name: string): string | null {
  try {
    const n = normalize(name.trim());
    return n.length > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * §9.3 step 3, per chain: chain coin type, then the ENSIP-19 default; null when neither has a record.
 * Throws EnsUnavailable (from the client) when the RPC call fails.
 */
export async function resolveOnChain(
  ens: EnsClient,
  config: Config,
  name: string,
  chain_id: ChainId,
): Promise<Address | null> {
  const first = await ens.getAddress(name, coinTypeFor(config, chain_id));
  const found = first ?? (await ens.getAddress(name, DEFAULT_EVM_COIN_TYPE));
  return found === null ? null : (getAddress(found) as Address);
}

export interface ChainAddress {
  chain_id: ChainId;
  address: Address;
}

/** §9.3 step 3 over several chains, in the given order. Chains without a record are left out. */
export async function resolveOnChains(
  ens: EnsClient,
  config: Config,
  name: string,
  chain_ids: ChainId[],
): Promise<ChainAddress[]> {
  const out: ChainAddress[] = [];
  for (const chain_id of chain_ids) {
    const address = await resolveOnChain(ens, config, name, chain_id);
    if (address !== null) out.push({ chain_id, address });
  }
  return out;
}

/** §9.3 step 7: first label of an ENS name (prefill for Q_NAME_FOR_ADDRESS). */
export function firstLabel(name: string): string {
  return name.split('.')[0] ?? name;
}
