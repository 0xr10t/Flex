import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBlockscoutSource } from '../../../src/history/blockscout.js';
import { HistoryCache } from '../../../src/history/cache.js';
import { validateConfig } from '../../../src/config/load.js';
import { testConfig } from '../../fakes/context.js';
import { CapturingLogger } from '../../fakes/io.js';

const config = testConfig();
config.history = { enabled: true, sources: [{ chain_id: 84532, api_url: 'https://history.invalid/api/v2' }] };
const wallet = config.wallet.address;
const sender = '0x00000000000000000000000000000000000000bb';
const contract = '0x00000000000000000000000000000000000000cc';
const usdc = config.chains.find((c) => c.chain_id === 84532)!.usdc_address;
const time = '2026-11-04T00:00:00.000Z';
const from = Date.parse('2026-11-02T00:00:00.000Z');
const through = Date.parse('2026-11-07T00:00:00.000Z');
const hash = (s: string) => `0x${s.repeat(64)}`;
const tx = (h = hash('a'), overrides = {}) => ({ hash: h, timestamp: time, from: { hash: sender }, to: { hash: wallet }, value: '100000000000000001', status: 'ok', block_number: 100, ...overrides });
const internal = (overrides = {}) => ({ transaction_hash: hash('b'), timestamp: time, from: { hash: contract }, to: { hash: wallet }, value: '2', type: 'call', success: true, index: 1, ...overrides });
const token = (overrides = {}) => ({ transaction_hash: hash('b'), timestamp: time, from: { hash: sender }, to: { hash: wallet }, token: { address_hash: usdc, type: 'ERC-20' }, total: { decimals: '6', value: '40000001' }, log_index: 1, ...overrides });
const page = (items: unknown[] = [], next_page_params: unknown = null) => ({ items, next_page_params });
type Route = (url: URL) => unknown;
function makeSource(route: Route = () => undefined) {
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.origin).toBe('https://history.invalid');
    expect(init?.redirect).toBe('error');
    const override = route(url);
    if (override instanceof Response) return override;
    if (override !== undefined) return Response.json(override);
    if (url.searchParams.get('action') === 'getblocknobytime') return Response.json({ status: '1', result: { blockNumber: url.searchParams.get('closest') === 'after' ? '100' : '200' } });
    if (url.searchParams.get('module') === 'account') {
      expect(url.searchParams.get('startblock')).toBe('100');
      expect(url.searchParams.get('endblock')).toBe('200');
      expect(url.searchParams.get('start_timestamp')).toBe(String(from / 1000));
      expect(url.searchParams.get('end_timestamp')).toBe(String(through / 1000));
      const h = url.searchParams.get('action') === 'txlist' ? hash('a') : hash('b');
      return Response.json({ status: '1', message: 'OK', result: [{ hash: h, transactionHash: h, to: wallet, from: sender, value: '1', blockNumber: '100', timeStamp: String(Date.parse(time) / 1000) }] });
    }
    if (url.pathname.endsWith('/internal-transactions')) return Response.json(page([internal()]));
    if (url.pathname.endsWith('/token-transfers')) return Response.json(page([token(), token({ log_index: 2, total: { decimals: '6', value: '1' } })]));
    if (url.pathname.endsWith(`/transactions/${hash('a')}`)) return Response.json(tx());
    return Response.json(tx(hash('b'), { to: { hash: contract }, value: '0' }));
  });
  const source = createBlockscoutSource(config, fetcher as typeof fetch);
  return { fetcher, source, read: () => source.read(84532, from, through, new AbortController().signal) };
}

afterEach(() => vi.useRealTimers());

describe('Blockscout received-transfer adapter (no network)', () => {
  it('reads all three incoming feeds, preserves wei precision and verifies parent success once per hash', async () => {
    const h = makeSource();
    const result = await h.read();
    expect(result).toHaveLength(4);
    expect(result[0]!.units).toBe(100000000000000001n);
    expect(result.filter((t) => t.token === 'USDC').reduce((n, t) => n + t.units, 0n)).toBe(40000002n);
    expect(h.fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith(`/transactions/${hash('b')}`))).toHaveLength(1);
    const tokenUrl = h.fetcher.mock.calls.map(([url]) => new URL(String(url))).find((url) => url.searchParams.get('action') === 'tokentx')!;
    expect(tokenUrl.searchParams.get('contractaddress')).toBe(usdc.toLowerCase());
    expect(h.fetcher.mock.calls.every(([url]) => !String(url).includes('/addresses/'))).toBe(true);
  });
  it('ignores failed, zero, self, outgoing, delegatecall and reverted-parent transfers', async () => {
    const h = makeSource((url) => {
      if (url.pathname.endsWith(`/transactions/${hash('a')}`)) return tx(hash('a'), { status: 'error' });
      if (url.pathname.endsWith('/internal-transactions')) return page([internal({ success: false }), internal({ index: 2, type: 'delegatecall' }), internal({ index: 3 })]);
      if (url.pathname.includes(`/transactions/${hash('b')}`)) return tx(hash('b'), { status: 'error' });
      return undefined;
    });
    expect(await h.read()).toEqual([]);
  });
  it.each([{ value: '0' }, { from: { hash: wallet } }, { to: { hash: sender } }])('excludes native zero/self/outgoing records', async (override) => {
    const result = await makeSource((url) => url.pathname.endsWith(`/transactions/${hash('a')}`) ? tx(hash('a'), override) : undefined).read();
    expect(result.some((t) => t.hash === hash('a'))).toBe(false);
  });
  it('does not count a top-level native transfer again as internal trace zero', async () => {
    const h = makeSource((url) => {
      if (url.searchParams.get('action') === 'txlistinternal') return { status: '1', result: [{ transactionHash: hash('a'), to: wallet, from: sender, value: '100000000000000001', blockNumber: '100', timeStamp: String(Date.parse(time) / 1000) }] };
      if (url.pathname.endsWith('/internal-transactions')) return page([internal({ transaction_hash: hash('a'), index: 0, from: { hash: sender }, value: '100000000000000001' })]);
      if (url.pathname.endsWith(`/transactions/${hash('a')}`)) return tx();
      return undefined;
    });
    expect((await h.read()).filter((t) => t.token === 'ETH')).toHaveLength(1);
  });
  it('paginates transaction details on the same base and deduplicates identical log events', async () => {
    const h = makeSource((url) => {
      if (!url.pathname.endsWith('/token-transfers')) return undefined;
      if (!url.searchParams.has('index')) return page([token()], { block_number: 100, index: 1, items_count: 50 });
      return page([token(), token({ log_index: 2 })]);
    });
    expect((await h.read()).filter((t) => t.token === 'USDC')).toHaveLength(2);
    expect(h.fetcher.mock.calls.filter(([url]) => String(url).includes('/token-transfers'))).toHaveLength(2);
  });
  it.each([
    page([token()], { next: 'https://attacker.invalid' }),
    page([token()], { filter: 'from' }),
    { ...page([token()]), meta: { status: 2 } },
    page([token({ total: { value: 40000001, decimals: '6' } })]),
    page([token({ total: { value: '40000001', decimals: '18' } })]),
    page([token({ token: { address_hash: 123, type: 'ERC-20' } })]),
    page([token(), token({ total: { value: '1', decimals: '6' } })]),
    page([token({ timestamp: null })]),
  ])('rejects incomplete or malformed data rather than inventing a total', async (body) => {
    await expect(makeSource((url) => url.pathname.endsWith('/token-transfers') ? body : undefined).read()).rejects.toThrow();
  });
  it('rejects repeated pagination keys and provider errors/redirects', async () => {
    await expect(makeSource((url) => url.pathname.endsWith('/token-transfers') ? page([token()], { index: 1 }) : undefined).read()).rejects.toThrow('repeated history');
    for (const status of [302, 429, 500]) await expect(makeSource(() => new Response('', { status })).read()).rejects.toThrow('history unavailable');
  });
  it('rejects oversized responses and unknown parent outcomes', async () => {
    await expect(makeSource(() => new Response(' '.repeat(2 * 1024 * 1024 + 1))).read()).rejects.toThrow('too large');
    await expect(makeSource((url) => url.pathname.endsWith(`/transactions/${hash('b')}`) ? tx(hash('b'), { status: null }) : undefined).read()).rejects.toThrow('unconfirmed history');
  });
  it('enforces the seven-day fetch cap before any network call and refuses out-of-range discovery records', async () => {
    const h = makeSource();
    await expect(h.source.read(84532, through - 7 * 86400000 - 1, through, new AbortController().signal)).rejects.toThrow('limited to seven days');
    expect(h.fetcher).not.toHaveBeenCalled();
    const bad = makeSource((url) => url.searchParams.get('module') === 'account' ? { status: '1', result: [{ hash: hash('a'), to: wallet, from: sender, value: '1', blockNumber: '50', timeStamp: String((from - 1000) / 1000) }] } : undefined);
    await expect(bad.read()).rejects.toThrow('outside requested window');
    expect(bad.fetcher.mock.calls.some(([url]) => String(url).includes(`/transactions/${hash('a')}`))).toBe(false);
  });
  it('does not fall back to an unbounded address scan when time bounds are unavailable', async () => {
    const h = makeSource((url) => url.searchParams.get('action') === 'getblocknobytime' ? { status: '0', message: 'unsupported', result: null } : undefined);
    await expect(h.read()).rejects.toThrow('time bounds unavailable');
    expect(h.fetcher.mock.calls.every(([url]) => new URL(String(url)).searchParams.get('action') === 'getblocknobytime')).toBe(true);
  });
});

describe('account-bound background cache', () => {
  it('deduplicates concurrent refreshes and completely replaces snapshots after a reorg or failure', async () => {
    const source = { read: vi.fn().mockResolvedValue([{ id: 'a' }]) };
    const cache = new HistoryCache({ address: wallet, chains: () => [84532], source, log: new CapturingLogger(), now: () => through });
    await Promise.all([cache.tick(), cache.tick()]);
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(cache.snapshot(84532)?.transfers).toHaveLength(1);
    source.read.mockResolvedValueOnce([]);
    await cache.tick();
    expect(cache.snapshot(84532)?.transfers).toEqual([]);
    source.read.mockRejectedValueOnce(new Error('secret-provider-url'));
    await cache.tick();
    expect(cache.snapshot(84532)?.status).toBe('unavailable');
    cache.stop();
  });
  it('starts on a jittered timer; reading snapshots causes no I/O; stopping discards late replies', async () => {
    vi.useFakeTimers();
    const source = { read: vi.fn().mockResolvedValue([]) };
    const cache = new HistoryCache({ address: wallet, chains: () => [84532], source, log: new CapturingLogger(), random: () => 0.5, intervalMs: 1000 });
    cache.start();
    await cache.tick();
    cache.snapshot(84532); cache.snapshot(84532);
    expect(source.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(source.read).toHaveBeenCalledTimes(2);
    let resolve!: (value: []) => void;
    source.read.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = cache.tick();
    cache.stop();
    resolve([]);
    await pending;
    await vi.advanceTimersByTimeAsync(5000);
    expect(cache.snapshot(84532)).toBeUndefined();
    expect(source.read).toHaveBeenCalledTimes(3);
  });
});

describe('history configuration', () => {
  it('is optional and allows a configured HTTPS or loopback API base', () => {
    expect(validateConfig(testConfig()).history).toBeUndefined();
    expect(validateConfig(config).history?.enabled).toBe(true);
    expect(validateConfig({ ...config, history: { enabled: true, sources: [{ chain_id: 84532, api_url: 'http://127.0.0.1:4000/api/v2/' }] } }).history?.enabled).toBe(true);
  });
  it.each(['http://provider.invalid/api/v2', 'https://u:p@provider.invalid/api/v2', 'https://provider.invalid/api/v2?apikey=secret', 'https://provider.invalid/api/v2#value', 'https://provider.invalid/anything', 'file:///api/v2'])('rejects unsafe or non-API bases without exposing their contents: %s', (api_url) => {
    expect(() => validateConfig({ ...config, history: { enabled: true, sources: [{ chain_id: 84532, api_url }] } })).toThrow();
  });
  it('rejects duplicate or unconfigured networks and empty enabled sources', () => {
    expect(() => validateConfig({ ...config, history: { enabled: true, sources: [] } })).toThrow();
    expect(() => validateConfig({ ...config, history: { enabled: true, sources: [config.history!.sources[0], config.history!.sources[0]] } })).toThrow();
    expect(() => validateConfig({ ...config, history: { enabled: true, sources: [{ chain_id: 1, api_url: 'https://history.invalid/api/v2' }] } })).toThrow();
  });
});
