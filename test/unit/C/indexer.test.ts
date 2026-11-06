// Lane C — §9.6 step 3-4 / §14.5 indexer SubnameSource: the parent-lookup request (C-191, C-192) and real timeout
// and pagination-failure paths (C-359). No network: fetch is injected.
import { namehash } from 'viem/ens';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexerUnavailable } from '../../../src/contracts/io.js';
import {
  INDEXER_TIMEOUT_MS,
  PAGE_SIZE,
  PARENT_QUERY,
  SUBNAMES_QUERY,
  createSubnameSource,
} from '../../../src/recipients/subnames.js';
import { testConfig } from '../../fakes/context.js';

type Body = { query: string; variables: Record<string, unknown> };

afterEach(() => vi.restoreAllMocks());

describe('§9.6 step 4 parent lookup request', () => {
  it('C-191 C-192 §9.6 step 4: PARENT_QUERY declares $id as ID! (the subgraph domain(id:) argument type)', () => {
    expect(PARENT_QUERY).toMatch(/query\s+Parent\(\s*\$id:\s*ID!\s*\)/);
    expect(PARENT_QUERY).not.toContain('$id: String');
    expect(PARENT_QUERY).toContain('domain(id: $id)');
  });

  it('C-191 C-192 §9.6 step 4: the POSTed body carries PARENT_QUERY with variables.id = namehash(parent)', async () => {
    const bodies: Body[] = [];
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      return Response.json({ data: body.query === PARENT_QUERY ? { domain: null } : { domains: [] } });
    }) as unknown as typeof fetch;
    expect(await createSubnameSource(testConfig(), fetchFn).listChildren('iitr.eth')).toBe('not_found');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.query).toBe(PARENT_QUERY);
    expect(bodies[0]?.query).toContain('$id: ID!');
    expect(bodies[0]?.variables).toEqual({ id: namehash('iitr.eth') });
  });

  it('C-191 §9.6 step 3: the children query uses the same namehash as `parent`', async () => {
    const bodies: Body[] = [];
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      return Response.json({ data: body.query === PARENT_QUERY ? { domain: { id: 'x' } } : { domains: [] } });
    }) as unknown as typeof fetch;
    await createSubnameSource(testConfig(), fetchFn).listChildren('iitr.eth');
    expect(bodies.map((b) => b.query)).toEqual([PARENT_QUERY, SUBNAMES_QUERY]);
    expect(bodies[1]?.variables).toEqual({ parent: namehash('iitr.eth'), skip: 0 });
  });
});

describe('§14.5 indexer timeout and pagination failures', () => {
  it('C-359 §14.5: each request is bound to AbortSignal.timeout(10000); an aborting fetch → IndexerUnavailable', async () => {
    const ac = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(ac.signal);
    const fetchFn = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
          setTimeout(() => ac.abort(), 0); // the deterministic "10 s elapsed"
        }),
    ) as unknown as typeof fetch;
    await expect(createSubnameSource(testConfig(), fetchFn).listChildren('iitr.eth')).rejects.toBeInstanceOf(
      IndexerUnavailable,
    );
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(INDEXER_TIMEOUT_MS).toBe(10_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn as unknown as { mock: { calls: Array<[unknown, RequestInit]> } }).mock.calls[0]?.[1].signal).toBe(
      ac.signal,
    );
  });

  it('C-359 §14.5: a hanging fetch is only ended by the signal (no response is invented)', async () => {
    const ac = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(ac.signal);
    let settled = false;
    const fetchFn = ((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        (init?.signal as AbortSignal).addEventListener('abort', () => rej(new Error('aborted')));
      })) as unknown as typeof fetch;
    const p = createSubnameSource(testConfig(), fetchFn)
      .listChildren('iitr.eth')
      .finally(() => (settled = true));
    p.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(IndexerUnavailable);
  });

  const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => ({ name: `m${i}.big.eth`, labelName: `m${i}` }));

  it.each([
    ['HTTP 500', () => new Response('no', { status: 500 })],
    ['GraphQL errors', () => Response.json({ errors: [{ message: 'boom' }] })],
    ['a rejected fetch', () => Promise.reject(new Error('network down'))],
    ['a malformed page', () => Response.json({ data: { domains: 'nope' } })],
  ])(
    'C-359 C-191 §9.6 step 3: page 2 fails after a full 1,000 page (%s) → IndexerUnavailable, no partial list',
    async (_l, second) => {
      const skips: unknown[] = [];
      const fetchFn = (async (_u: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Body;
        if (body.query === PARENT_QUERY) return Response.json({ data: { domain: { id: body.variables.id } } });
        skips.push(body.variables.skip);
        if (body.variables.skip === 0) return Response.json({ data: { domains: fullPage } });
        return second();
      }) as unknown as typeof fetch;
      await expect(createSubnameSource(testConfig(), fetchFn).listChildren('big.eth')).rejects.toBeInstanceOf(
        IndexerUnavailable,
      );
      expect(skips).toEqual([0, 1000]);
    },
  );

  it('C-359 §14.5: a timeout on page 2 (signal aborts the second request) → IndexerUnavailable', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const second = new AbortController();
    let n = 0;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => (++n === 3 ? second.signal : real(ms)));
    const fetchFn = ((_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body;
      if (body.query === PARENT_QUERY) return Promise.resolve(Response.json({ data: { domain: { id: 'x' } } }));
      if (body.variables.skip === 0) return Promise.resolve(Response.json({ data: { domains: fullPage } }));
      return new Promise<Response>((_res, rej) => {
        (init?.signal as AbortSignal).addEventListener('abort', () => rej(new DOMException('t', 'TimeoutError')));
        setTimeout(() => second.abort(), 0);
      });
    }) as unknown as typeof fetch;
    await expect(createSubnameSource(testConfig(), fetchFn).listChildren('big.eth')).rejects.toBeInstanceOf(
      IndexerUnavailable,
    );
    expect(n).toBe(3);
  });
});
