// Implements: §14.5 ENS — viem public client for `ens.rpc_chain_id` over the anon-rpc URL (10 s timeout, no
// retries), `getEnsAddress({ name, coinType, universalResolverAddress })` with the Universal Resolver from config;
// a failed or timed-out call throws EnsUnavailable (§9.4 "RPC unavailable", §14.5 "fails the ENS lookup").

import { createPublicClient, getAddress, http, type PublicClient } from 'viem';
import { getEnsAddress } from 'viem/actions';
import { EnsUnavailable, type EnsClient } from '../contracts/io.js';
import type { Address, Config } from '../contracts/types.js';

export const ENS_TIMEOUT_MS = 10_000;

/** Optional seam for tests: a prebuilt viem client (no network in unit tests). */
export function createEnsClient(config: Config, client?: PublicClient): EnsClient {
  const chain = config.chains.find((c) => c.chain_id === config.ens.rpc_chain_id);
  if (!chain) throw new Error('ens.rpc_chain_id is not a configured chain');
  const pc =
    client ?? createPublicClient({ transport: http(chain.rpc_url, { timeout: ENS_TIMEOUT_MS, retryCount: 0 }) });
  const universalResolverAddress = config.ens.universal_resolver_address;
  return {
    async getAddress(name: string, coinType: bigint): Promise<Address | null> {
      let found: Address | null;
      try {
        found = await getEnsAddress(pc, { name, coinType, universalResolverAddress });
      } catch {
        throw new EnsUnavailable();
      }
      return found === null ? null : (getAddress(found) as Address);
    },
  };
}
