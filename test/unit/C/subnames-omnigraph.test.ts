// §9.6 step 3 through ENSNode's Omnigraph, the indexer for ENSv2 on Sepolia. The transport is faked here: the hosted endpoint's
// TLS certificate didn't match its hostname when this was written, so it hasn't been called live.
import { describe, expect, it } from 'vitest';
import { IndexerUnavailable } from '../../../src/contracts/io.js';
import { createSubnameSource } from '../../../src/recipients/subnames.js';
import { testConfig } from '../../fakes/context.js';

const config = () => {
  const c = testConfig();
  return {
    ...c,
    ens: { ...c.ens, indexer_kind: 'ensnode-omnigraph' as const, indexer_url: 'https://indexer.test/api/omnigraph' },
  };
};
const edge = (name: string | null) => ({ node: { canonical: name === null ? null : { name: { interpreted: name } } } });
const page = (names: (string | null)[], next: string | null = null) => ({
  domain: {
    id: 'x',
    subdomains: { pageInfo: { hasNextPage: next !== null, endCursor: next }, edges: names.map(edge) },
  },
});
const respond = (bodies: unknown[]) => {
  const sent: { query: string; variables: Record<string, unknown> }[] = [];
  let at = 0;
  const fetchFn = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    const body = bodies[Math.min(at++, bodies.length - 1)];
    return { ok: true, json: async () => ({ data: body }) };
  }) as unknown as typeof fetch;
  return { fetchFn, sent };
};

describe('listing an organisation through the Omnigraph', () => {
  it('returns its members', async () => {
    const { fetchFn, sent } = respond([page(['alice.iitr.eth', 'bob.iitr.eth'])]);
    expect(await createSubnameSource(config(), fetchFn).listChildren('iitr.eth')).toEqual([
      'alice.iitr.eth',
      'bob.iitr.eth',
    ]);
    expect(sent[0]?.variables).toEqual({ name: 'iitr.eth', after: null });
  });

  it('follows pages by cursor', async () => {
    const { fetchFn, sent } = respond([page(['a.iitr.eth'], 'c1'), page(['b.iitr.eth'])]);
    expect(await createSubnameSource(config(), fetchFn).listChildren('iitr.eth')).toEqual(['a.iitr.eth', 'b.iitr.eth']);
    expect(sent[1]?.variables.after).toBe('c1');
  });

  it('says when the organisation is not in ENS', async () => {
    const { fetchFn } = respond([{ domain: null }]);
    expect(await createSubnameSource(config(), fetchFn).listChildren('nope.eth')).toBe('not_found');
  });

  it('leaves out members with no usable name', async () => {
    const { fetchFn } = respond([page(['ok.iitr.eth', null, '[abc123].iitr.eth'])]);
    expect(await createSubnameSource(config(), fetchFn).listChildren('iitr.eth')).toEqual(['ok.iitr.eth']);
  });

  it('an empty organisation gives an empty list', async () => {
    const { fetchFn } = respond([page([])]);
    expect(await createSubnameSource(config(), fetchFn).listChildren('iitr.eth')).toEqual([]);
  });

  it('a page that claims more but gives no way on is an indexer failure, not an endless loop', async () => {
    const stuck = page(['a.iitr.eth'], 'same');
    const { fetchFn } = respond([stuck, stuck]);
    await expect(createSubnameSource(config(), fetchFn).listChildren('iitr.eth')).rejects.toBeInstanceOf(
      IndexerUnavailable,
    );
  });

  it('a malformed answer is an indexer failure', async () => {
    const { fetchFn } = respond([{ domain: { id: 'x', subdomains: {} } }]);
    await expect(createSubnameSource(config(), fetchFn).listChildren('iitr.eth')).rejects.toBeInstanceOf(
      IndexerUnavailable,
    );
  });

  it('refuses a plain-HTTP indexer, because it decides who gets paid', async () => {
    const c = config();
    const { fetchFn, sent } = respond([page([])]);
    const source = createSubnameSource({ ...c, ens: { ...c.ens, indexer_url: 'http://indexer.test' } }, fetchFn);
    await expect(source.listChildren('iitr.eth')).rejects.toBeInstanceOf(IndexerUnavailable);
    expect(sent).toHaveLength(0);
  });
});
