// Implements: §14.5 ENS — viem public client for `ens.rpc_chain_id` over the anon-rpc URL (10 s timeout, no
// retries), `getEnsAddress({ name, coinType, universalResolverAddress })` with the Universal Resolver from config;
// a failed or timed-out call throws EnsUnavailable (§9.4 "RPC unavailable", §14.5 "fails the ENS lookup"); a record
// that is not a 20-byte address is "no address" (null).

import { createPublicClient, getAddress, http, isAddress, type PublicClient } from 'viem';
import { getEnsAddress } from 'viem/actions';
import { EnsUnavailable, type EnsClient } from '../contracts/io.js';
import type { Address, Config } from '../contracts/types.js';

export const ENS_TIMEOUT_MS = 10_000;

/**
 * viem errors thrown while decoding the resolver's record, after the call succeeded (getEnsAddress decodes the
 * `addr` result outside `readContract`, so these arrive unwrapped). A transport or RPC failure arrives wrapped
 * (CallExecutionError / ContractFunctionExecutionError) and stays EnsUnavailable.
 */
const RECORD_DECODE_ERRORS = new Set([
  'AbiDecodingDataSizeTooSmallError',
  'AbiDecodingZeroDataError',
  'IntegerOutOfRangeError',
  'PositionOutOfBoundsError',
  'RecursiveReadLimitExceededError',
  'SliceOffsetOutOfBoundsError',
  'SizeOverflowError',
  'InvalidAddressError',
]);

function isRecordDecodeError(e: unknown): boolean {
  return e instanceof Error && RECORD_DECODE_ERRORS.has(e.name);
}

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
      } catch (e) {
        // The resolver answered, but its record could not be decoded as an address (R3-4): no address.
        if (isRecordDecodeError(e)) return null;
        throw new EnsUnavailable();
      }
      if (found === null) return null;
      // A coin-type record is raw bytes: one that is not a 20-byte address (e.g. 32 bytes) is "no address on that
      // chain", not a failure of the lookup (R3-4).
      if (!isAddress(found, { strict: false })) return null;
      return getAddress(found) as Address;
    },
  };
}
