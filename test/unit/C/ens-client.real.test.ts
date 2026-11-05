// Lane C — §14.5 ENS client with the REAL viem getEnsAddress (C-358). No network: the viem client uses a `custom`
// transport whose `request` is controlled here. (io.test.ts mocks viem/actions; vi.mock is file-scoped, hence this file.)
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeAbiParameters,
  type PublicClient,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { EnsUnavailable } from '../../../src/contracts/io.js';
import { createEnsClient } from '../../../src/recipients/ens-client.js';
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

function clientWith(handler: (req: Req) => unknown): { client: PublicClient; calls: Req[] } {
  const calls: Req[] = [];
  const client = createPublicClient({
    transport: custom(
      {
        async request(req: Req) {
          calls.push(req);
          return handler(req);
        },
      },
      { retryCount: 0 }, // as production's http transport (§14.5: no retries)
    ),
  }) as PublicClient;
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
});
