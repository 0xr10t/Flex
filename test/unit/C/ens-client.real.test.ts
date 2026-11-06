// Lane C — §14.5 ENS client with the REAL viem getEnsAddress (C-358). No network: the viem client uses a `custom`
// transport whose `request` is controlled here. (io.test.ts mocks viem/actions; vi.mock is file-scoped, hence this file.)
import {
  BaseError,
  custom,
  toFunctionSelector,
  decodeFunctionData,
  encodeErrorResult,
  encodeAbiParameters,
  type Transport,
} from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnsUnavailable } from '../../../src/contracts/io.js';
import { OFFCHAIN_LOOKUP_SELECTOR, createEnsClient, isOffchainLookup } from '../../../src/recipients/ens-client.js';
import { testConfig } from '../../fakes/context.js';
import { RIYA } from './helpers.js';

// The two ABI fragments getEnsAddress uses (viem does not export them).
const universalResolverResolveAbi = [
  { type: 'error', name: 'ResolverNotFound', inputs: [{ name: 'name', type: 'bytes' }] },
  {
    type: 'function',
    name: 'resolveWithGateways',
    stateMutability: 'view',
    inputs: [
      { name: 'name', type: 'bytes' },
      { name: 'data', type: 'bytes' },
      { name: 'gateways', type: 'string[]' },
    ],
    outputs: [
      { name: '', type: 'bytes' },
      { name: 'address', type: 'address' },
    ],
  },
] as const;
const addressResolverAbi = [
  {
    type: 'function',
    name: 'addr',
    stateMutability: 'view',
    inputs: [
      { name: 'name', type: 'bytes32' },
      { name: 'coinType', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
] as const;

type Req = { method: string; params?: unknown[] };

/** A transport for the production client (createEnsClient keeps its own client options, e.g. ccipRead: false). */
function clientWith(handler: (req: Req) => unknown): { client: Transport; calls: Req[] } {
  const calls: Req[] = [];
  const client = custom(
    {
      async request(req: Req) {
        calls.push(req);
        return handler(req);
      },
    },
    { retryCount: 0 }, // as production's http transport (§14.5: no retries)
  );
  return { client, calls };
}

describe('§14.5 ENS client over the real viem getEnsAddress (custom transport)', () => {
  it('C-358 §14.5: a successful Universal Resolver result → the checksummed address; eth_call goes to the configured resolver', async () => {
    const cfg = testConfig();
    const { client, calls } = clientWith((req) => {
      expect(req.method).toBe('eth_call');
      const tx = (req.params?.[0] ?? {}) as { to?: string; data?: `0x${string}` };
      expect(tx.to?.toLowerCase()).toBe(cfg.ens.universal_resolver_address.toLowerCase());
      const outer = decodeFunctionData({ abi: universalResolverResolveAbi, data: tx.data as `0x${string}` });
      expect(outer.functionName).toBe('resolveWithGateways');
      const inner = decodeFunctionData({ abi: addressResolverAbi, data: outer.args?.[1] as `0x${string}` });
      expect(inner.functionName).toBe('addr');
      // addr(node, coinType) result is `bytes`: the 20 raw address bytes; the outer result is (bytes, address).
      return encodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], [RIYA.toLowerCase() as `0x${string}`, RIYA]);
    });
    const ens = createEnsClient(cfg, client);
    expect(await ens.getAddress('riya.eth', 0x80000000n | 84532n)).toBe(RIYA);
    expect(calls).toHaveLength(1);
  });

  it('C-358 §14.5: a Universal Resolver revert ResolverNotFound → null (no address, not unavailable)', async () => {
    const data = encodeErrorResult({
      abi: universalResolverResolveAbi,
      errorName: 'ResolverNotFound',
      args: ['0x03657468'],
    });
    const { client } = clientWith(() => {
      throw Object.assign(new Error('execution reverted'), { code: 3, data });
    });
    expect(await createEnsClient(testConfig(), client).getAddress('nobody.eth', 60n)).toBeNull();
  });

  it('C-358 §14.5: an empty result (no record) → null', async () => {
    const { client } = clientWith(() => encodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], ['0x', RIYA]));
    expect(await createEnsClient(testConfig(), client).getAddress('riya.eth', 60n)).toBeNull();
  });

  it('C-358 §14.5: a transport failure → EnsUnavailable', async () => {
    const { client } = clientWith(() => {
      throw new Error('connect ECONNREFUSED');
    });
    await expect(createEnsClient(testConfig(), client).getAddress('riya.eth', 60n)).rejects.toBeInstanceOf(
      EnsUnavailable,
    );
  });

  it('C-358 §14.5: a JSON-RPC server error (not a revert) → EnsUnavailable', async () => {
    const { client } = clientWith(() => {
      throw Object.assign(new Error('internal error'), { code: -32603 });
    });
    await expect(createEnsClient(testConfig(), client).getAddress('riya.eth', 60n)).rejects.toBeInstanceOf(
      EnsUnavailable,
    );
  });

  it('R3-4: a record that is not a 20-byte address (32 bytes) → null, not a throw', async () => {
    const bytes32 = `0x${'ab'.repeat(32)}` as `0x${string}`;
    const { client } = clientWith(() => encodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], [bytes32, RIYA]));
    expect(await createEnsClient(testConfig(), client).getAddress('riya.eth', 0x80000000n | 84532n)).toBeNull();
  });

  it('R3-4: realistic ABI-encoded 32-byte inner record → null, not InvalidAddressError', async () => {
    const bytes32 = `0x${'ab'.repeat(32)}` as `0x${string}`;
    const inner = encodeAbiParameters([{ type: 'bytes' }], [bytes32]);
    const { client } = clientWith(() => encodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], [inner, RIYA]));
    expect(await createEnsClient(testConfig(), client).getAddress('riya.eth', 0x80000000n | 84532n)).toBeNull();
  });
});

const OFFCHAIN_LOOKUP_ABI = [
  {
    type: 'error',
    name: 'OffchainLookup',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'urls', type: 'string[]' },
      { name: 'callData', type: 'bytes' },
      { name: 'callbackFunction', type: 'bytes4' },
      { name: 'extraData', type: 'bytes' },
    ],
  },
] as const;

/** What the Universal Resolver reverts with when the name's resolver is offchain (EIP-3668, sender = the resolver). */
function offchainRevert(sender: `0x${string}`): never {
  const data = encodeErrorResult({
    abi: OFFCHAIN_LOOKUP_ABI,
    errorName: 'OffchainLookup',
    args: [
      sender,
      ['https://gateway.attacker.invalid/{sender}/{data}', 'x-batch-gateway:true'],
      '0xabcd',
      '0x12345678',
      '0x',
    ],
  });
  throw Object.assign(new Error('execution reverted'), { code: 3, data });
}

describe('privacy fix 3: CCIP-Read is off for ENS', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a name whose resolver answers with an offchain lookup → null (no address), and no gateway URL is fetched', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const cfg = testConfig();
    const { client, calls } = clientWith(() => offchainRevert(cfg.ens.universal_resolver_address));
    expect(await createEnsClient(cfg, client).getAddress('bob.attacker.eth', 60n)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    // One eth_call only: nothing was followed.
    expect(calls.map((c) => c.method)).toEqual(['eth_call']);
  });

  it('the same with a sender other than the resolver (still never fetched)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const { client } = clientWith(() => offchainRevert('0x000000000000000000000000000000000000dEaD'));
    expect(await createEnsClient(testConfig(), client).getAddress('bob.attacker.eth', 60n)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('a different revert is still "unavailable", not "no address"', async () => {
    const { client } = clientWith(() => {
      throw Object.assign(new Error('execution reverted'), { code: 3, data: '0xdeadbeef' });
    });
    await expect(createEnsClient(testConfig(), client).getAddress('riya.eth', 60n)).rejects.toBeInstanceOf(
      EnsUnavailable,
    );
  });

  it('isOffchainLookup: only viem errors carrying the OffchainLookup selector', () => {
    expect(isOffchainLookup(new Error('x'))).toBe(false);
    expect(isOffchainLookup(null)).toBe(false);
    expect(
      isOffchainLookup(new BaseError('x', { cause: Object.assign(new Error('y'), { data: '0x556f1830ab' }) })),
    ).toBe(true);
    expect(isOffchainLookup(new BaseError('x', { cause: Object.assign(new Error('y'), { data: '0x556F1830' }) }))).toBe(
      true,
    );
    expect(isOffchainLookup(new BaseError('x', { cause: Object.assign(new Error('y'), { data: '0x12345678' }) }))).toBe(
      false,
    );
    expect(
      isOffchainLookup(
        new BaseError('x', { cause: Object.assign(new Error('y'), { data: { errorName: 'OffchainLookup' } }) }),
      ),
    ).toBe(true);
    expect(OFFCHAIN_LOOKUP_SELECTOR).toBe(toFunctionSelector('OffchainLookup(address,string[],bytes,bytes4,bytes)'));
  });
});
