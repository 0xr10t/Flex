// Implements: §14.5 ENS — viem public client for `ens.rpc_chain_id` over the anon-rpc URL (10 s timeout, no
// retries), `getEnsAddress({ name, coinType, universalResolverAddress })` with the Universal Resolver from config;
// a failed or timed-out call throws EnsUnavailable (§9.4 "RPC unavailable", §14.5 "fails the ENS lookup"); a record
// that is not a 20-byte address is "no address" (null).
// Privacy fix 3: CCIP-Read is off. A name whose resolver answers with an offchain lookup would make viem fetch a URL the
// resolver chose, straight from this machine and outside anon-rpc, so such a name has "no address" here. Fix 7: the ENS
// client has its own connection pool (its own Tor circuit when `network.socks_proxy` is set), never shared with balance
// reads, and random JSON-RPC ids.

import { BaseError, createPublicClient, getAddress, isAddress, type Transport } from 'viem';
import { getEnsAddress } from 'viem/actions';
import { EnsUnavailable, type EnsClient } from '../contracts/io.js';
import type { Address, Config } from '../contracts/types.js';
import { isolatedHttp } from '../util/isolated-fetch.js';

export const ENS_TIMEOUT_MS = 10_000;

/** Selector of EIP-3668 `OffchainLookup(address,string[],bytes,bytes4,bytes)`. */
export const OFFCHAIN_LOOKUP_SELECTOR = '0x556f1830';

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

/** True when the call reverted with an EIP-3668 offchain lookup (the revert data, raw or decoded, anywhere in the cause chain). */
export function isOffchainLookup(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  return (
    e.walk((c) => {
      const err = c as { data?: unknown; raw?: unknown };
      const hex = [err.data, err.raw].find((v): v is string => typeof v === 'string');
      const decoded = err.data as { errorName?: unknown } | undefined;
      return (
        hex?.toLowerCase().startsWith(OFFCHAIN_LOOKUP_SELECTOR) === true || decoded?.errorName === 'OffchainLookup'
      );
    }) !== null
  );
}

/** Optional seam for tests: the transport (no network in unit tests). The client options stay the production ones. */
export function createEnsClient(config: Config, transport?: Transport): EnsClient {
  const chain = config.chains.find((c) => c.chain_id === config.ens.rpc_chain_id);
  if (!chain) throw new Error('ens.rpc_chain_id is not a configured chain');
  const pc = createPublicClient({
    transport:
      transport ?? isolatedHttp(ENS_TIMEOUT_MS, { proxy: config.network.socks_proxy, isolation: 'ens' })(chain.rpc_url),
    ccipRead: false,
  });
  const universalResolverAddress = config.ens.universal_resolver_address;
  return {
    async getAddress(name: string, coinType: bigint): Promise<Address | null> {
      let found: Address | null;
      try {
        found = await getEnsAddress(pc, { name, coinType, universalResolverAddress });
      } catch (e) {
        // The resolver answered, but its record could not be decoded as an address (R3-4): no address.
        if (isRecordDecodeError(e)) return null;
        // Fix 3: the record lives offchain, and following it would leave anon-rpc: no address here.
        if (isOffchainLookup(e)) return null;
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
