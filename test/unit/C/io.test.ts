// Lane C — §14.5 ENS client (Universal Resolver on ens.rpc_chain_id) and §9.6 step 3 / §14.5 indexer SubnameSource.
// No network: viem's getEnsAddress is mocked, and the SubnameSource gets an injected fetch.
import { custom } from 'viem';
import { namehash } from 'viem/ens';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnsUnavailable, IndexerUnavailable } from '../../../src/contracts/io.js';
import { createEnsClient, ENS_TIMEOUT_MS } from '../../../src/recipients/ens-client.js';
import {
  INDEXER_TIMEOUT_MS,
  PAGE_SIZE,
  SUBNAMES_QUERY,
  createSubnameSource,
} from '../../../src/recipients/subnames.js';
import { testConfig } from '../../fakes/context.js';
import { RIYA } from './helpers.js';

const getEnsAddress = vi.fn();
vi.mock('viem/actions', () => ({ getEnsAddress: (...args: unknown[]) => getEnsAddress(...args) }));

const fakeTransport = custom({ request: async () => null });

describe('§14.5 ENS client', () => {
  beforeEach(() => getEnsAddress.mockReset());

  it('C-358 §14.5: getEnsAddress({ name, coinType, universalResolverAddress }) on the configured client', async () => {
    getEnsAddress.mockResolvedValue(RIYA);
    const cfg = testConfig();
    const ens = createEnsClient(cfg, fakeTransport);
    expect(await ens.getAddress('riya.eth', 60n)).toBe(RIYA);
    expect(getEnsAddress).toHaveBeenCalledWith(expect.objectContaining({ ccipRead: false }), {
      name: 'riya.eth',
      coinType: 60n,
      universalResolverAddress: cfg.ens.universal_resolver_address,
    });
  });

  it('C-358 §14.5: a lowercase record is returned EIP-55 checksummed; no record → null', async () => {
    const ens = createEnsClient(testConfig(), fakeTransport);
    getEnsAddress.mockResolvedValueOnce(RIYA.toLowerCase());
    expect(await ens.getAddress('riya.eth', 60n)).toBe(RIYA);
    getEnsAddress.mockResolvedValueOnce(null);
    expect(await ens.getAddress('riya.eth', 60n)).toBeNull();
  });

  it('C-358 §14.5: an RPC failure or timeout → EnsUnavailable (distinct from "no address")', async () => {
    const ens = createEnsClient(testConfig(), fakeTransport);
    getEnsAddress.mockRejectedValueOnce(new Error('timeout'));
    await expect(ens.getAddress('riya.eth', 60n)).rejects.toBeInstanceOf(EnsUnavailable);
  });

  it('C-358 §14.5: the client is for ens.rpc_chain_id (must be a configured chain); 10 s timeout', () => {
    const cfg = testConfig();
    expect(() => createEnsClient({ ...cfg, ens: { ...cfg.ens, rpc_chain_id: 84532 } })).not.toThrow();
    expect(() => createEnsClient({ ...cfg, chains: cfg.chains.filter((c) => c.chain_id !== 11155111) })).toThrow();
    expect(ENS_TIMEOUT_MS).toBe(10_000);
  });
});

type Body = { query: string; variables: Record<string, unknown> };

/** A fake indexer: answers the parent lookup and the paged subname query. */
function indexer(opts: { exists?: boolean; children?: string[]; status?: number; errors?: boolean }) {
  const calls: Array<{ url: string; init: RequestInit; body: Body }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    calls.push({ url: String(url), init: init ?? {}, body });
    if (opts.status !== undefined && opts.status !== 200) return new Response('no', { status: opts.status });
    if (opts.errors) return Response.json({ errors: [{ message: 'boom' }] });
    if (body.query.includes('domain(id')) {
      return Response.json({ data: { domain: opts.exists === false ? null : { id: body.variables.id } } });
    }
    const skip = body.variables.skip as number;
    const page = (opts.children ?? []).slice(skip, skip + PAGE_SIZE).map((name) => ({
      name,
      labelName: name.split('.')[0],
    }));
    return Response.json({ data: { domains: page } });
  });
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

describe('§9.6 step 3 SubnameSource (ens-subgraph)', () => {
  it('C-191 C-359 §9.6 step 3: HTTPS POST GraphQL to ens.indexer_url with the reference query and namehash(parent)', async () => {
    const { calls, fetchFn } = indexer({ children: ['alice.iitr.eth', 'bob.iitr.eth'] });
    const src = createSubnameSource(testConfig(), fetchFn);
    expect(await src.listChildren('iitr.eth')).toEqual(['alice.iitr.eth', 'bob.iitr.eth']);
    const page = calls.find((c) => c.body.query === SUBNAMES_QUERY);
    expect(page).toBeDefined();
    expect(page?.url).toBe('https://indexer.invalid/graphql');
    expect(page?.init.method).toBe('POST');
    expect(page?.body.variables).toEqual({ parent: namehash('iitr.eth'), skip: 0 });
    expect(SUBNAMES_QUERY).toContain('domains(where: { parent: $parent }, first: 1000, skip: $skip, orderBy: name)');
    expect(page?.init.signal).toBeInstanceOf(AbortSignal);
    expect(INDEXER_TIMEOUT_MS).toBe(10_000);
  });

  it('C-191 §9.6 step 3: paginated 1,000 at a time until a short page', async () => {
    const children = Array.from({ length: 2345 }, (_, i) => `m${String(i).padStart(4, '0')}.big.eth`);
    const { calls, fetchFn } = indexer({ children });
    const out = await createSubnameSource(testConfig(), fetchFn).listChildren('big.eth');
    expect(out).toHaveLength(2345);
    expect(calls.filter((c) => c.body.query === SUBNAMES_QUERY).map((c) => c.body.variables.skip)).toEqual([
      0, 1000, 2000,
    ]);
  });

  it('C-191 §9.6 step 3: an exact multiple of 1,000 asks one more (empty) page', async () => {
    const children = Array.from({ length: 1000 }, (_, i) => `m${i}.x.eth`);
    const { calls, fetchFn } = indexer({ children });
    expect(await createSubnameSource(testConfig(), fetchFn).listChildren('x.eth')).toHaveLength(1000);
    expect(calls.filter((c) => c.body.query === SUBNAMES_QUERY)).toHaveLength(2);
  });

  it('C-192 §9.6 step 4: parent with no domain entity → "not_found"', async () => {
    const { fetchFn } = indexer({ exists: false });
    expect(await createSubnameSource(testConfig(), fetchFn).listChildren('iitr.ac.in')).toBe('not_found');
  });

  it('C-193 §9.6 step 5: a known parent with no children → []', async () => {
    const { fetchFn } = indexer({ children: [] });
    expect(await createSubnameSource(testConfig(), fetchFn).listChildren('empty.eth')).toEqual([]);
  });

  it.each([
    ['HTTP 500', { status: 500 }],
    ['GraphQL errors', { errors: true }],
  ])('C-191 C-376 §9.6 step 3: indexer error (%s) → IndexerUnavailable', async (_l, o) => {
    const { fetchFn } = indexer(o);
    await expect(createSubnameSource(testConfig(), fetchFn).listChildren('iitr.eth')).rejects.toBeInstanceOf(
      IndexerUnavailable,
    );
  });

  it('C-191 §9.6 step 3: a timeout / network failure → IndexerUnavailable', async () => {
    const fetchFn = vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    }) as unknown as typeof fetch;
    await expect(createSubnameSource(testConfig(), fetchFn).listChildren('iitr.eth')).rejects.toBeInstanceOf(
      IndexerUnavailable,
    );
  });

  it('C-359 §14.5: a non-HTTPS indexer URL is never called', async () => {
    const { calls, fetchFn } = indexer({ children: [] });
    const cfg = testConfig();
    const src = createSubnameSource(
      { ...cfg, ens: { ...cfg.ens, indexer_url: 'http://indexer.invalid/graphql' } },
      fetchFn,
    );
    await expect(src.listChildren('iitr.eth')).rejects.toBeInstanceOf(IndexerUnavailable);
    expect(calls).toHaveLength(0);
  });
});
