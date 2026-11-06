// anon-rpc over Tor, against a stand-in SOCKS5 server (test/fakes/socks-server.ts) and local HTTP/TLS servers. Hostnames
// end in `.test`, which can't be resolved here: a request only works if the proxy resolves it, so a local DNS lookup
// would fail the test.
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { getAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRpcClients } from '../../../src/pipeline/s0-balances.js';
import { createContentFetcher, hostAllowedViaProxy } from '../../../src/quarantine/fetch.js';
import { createEnsClient } from '../../../src/recipients/ens-client.js';
import { createSubnameSource } from '../../../src/recipients/subnames.js';
import { IndexerUnavailable } from '../../../src/contracts/io.js';
import { isolatedFetch, proxyAgent } from '../../../src/util/isolated-fetch.js';
import { testConfig } from '../../fakes/context.js';
import { FakeSocks } from '../../fakes/socks-server.js';

const TLS = {
  key: readFileSync(new URL('../../fixtures/tls/key.pem', import.meta.url)),
  cert: readFileSync(new URL('../../fixtures/tls/cert.pem', import.meta.url)),
};

let socks: FakeSocks;
let rpc: Server;
let rpcPort: number;
let rpcHits: number;
let tls: TlsServer;
let tlsPort: number;
let sni: string[];

beforeEach(async () => {
  socks = await new FakeSocks().start();
  rpcHits = 0;
  rpc = createHttpServer((req, res) => {
    rpcHits++;
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = raw === '' ? { id: 1, method: '' } : (JSON.parse(raw) as { id: number; method: string });
      const result = body.method === 'eth_getBalance' ? '0x2a' : '0x' + '7'.padStart(64, '0');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', r));
  rpcPort = (rpc.address() as AddressInfo).port;
  sni = [];
  tls = createTlsServer({
    ...TLS,
    SNICallback: (name, cb) => {
      sni.push(name);
      cb(null, undefined);
    },
  });
  tls.on('tlsClientError', () => {});
  await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
  tlsPort = (tls.address() as AddressInfo).port;
  for (const host of ['rpc.test', 'indexer.test']) socks.hosts.set(host, rpcPort);
  socks.hosts.set('docs.test', tlsPort);
  socks.hosts.set('secure-rpc.test', tlsPort);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await socks.stop();
  rpc.closeAllConnections();
  await new Promise<void>((r) => rpc.close(() => r()));
  await new Promise<void>((r) => tls.close(() => r()));
});

const rpcBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
const post = (f: typeof fetch, url: string) =>
  f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: rpcBody });

describe('isolatedFetch through Tor', () => {
  it('sends the hostname to the proxy (no DNS here) and gets the answer back', async () => {
    const res = await post(isolatedFetch({ proxy: socks.url, isolation: 'balances' }), `http://rpc.test:${rpcPort}/`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: '0x' + '7'.padStart(64, '0') });
    expect(socks.connects).toEqual([
      {
        user: 'balances',
        pass: expect.stringMatching(/^[0-9a-f]{16}$/),
        atyp: 'domain',
        host: 'rpc.test',
        port: rpcPort,
      },
    ]);
  });

  it('one circuit per kind of query: each class has its own SOCKS username; the same class keeps one', async () => {
    const balances = isolatedFetch({ proxy: socks.url, isolation: 'balances' });
    const ens = isolatedFetch({ proxy: socks.url, isolation: 'ens' });
    for (const f of [balances, ens, balances, ens]) await (await post(f, `http://rpc.test:${rpcPort}/`)).text();
    expect(socks.connects.map((c) => c.user)).toEqual(['balances', 'ens', 'balances', 'ens']);
    const creds = new Set(socks.connects.map((c) => `${c.user}:${c.pass}`));
    expect(creds.size).toBe(2);
  });

  it('no keep-alive through Tor: every request is a new stream', async () => {
    const f = isolatedFetch({ proxy: socks.url, isolation: 'ens' });
    for (let i = 0; i < 3; i++) await (await post(f, `http://rpc.test:${rpcPort}/`)).text();
    expect(socks.connects).toHaveLength(3);
  });

  it('fails closed: with the proxy down the request fails and nothing goes direct', async () => {
    await socks.stop();
    // rpc.test can't resolve here, so use the real port by IP too: neither may be reached.
    const f = isolatedFetch({ proxy: socks.url, isolation: 'balances' });
    await expect(post(f, `http://rpc.test:${rpcPort}/`)).rejects.toThrow();
    await expect(post(f, `https://1.1.1.1:${rpcPort}/`)).rejects.toThrow();
    expect(rpcHits).toBe(0);
  });

  it('a node on this machine (127.0.0.1) is reached directly, not through Tor', async () => {
    const res = await post(isolatedFetch({ proxy: socks.url, isolation: 'balances' }), `http://127.0.0.1:${rpcPort}/`);
    expect(res.status).toBe(200);
    expect(socks.connects).toEqual([]);
    expect(rpcHits).toBe(1);
  });

  it('TLS runs end to end through the proxy, with the hostname as SNI and the certificate still verified', async () => {
    const f = isolatedFetch({ proxy: socks.url, isolation: 'balances' });
    await expect(post(f, `https://secure-rpc.test:${tlsPort}/`)).rejects.toThrow(/self[- ]signed/i);
    expect(sni).toEqual(['secure-rpc.test']);
    expect(socks.connects[0]).toMatchObject({ atyp: 'domain', host: 'secure-rpc.test' });
  });

  it('never uses the global fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await (await post(isolatedFetch({ proxy: socks.url, isolation: 'x' }), `http://rpc.test:${rpcPort}/`)).text();
    expect(spy).not.toHaveBeenCalled();
  });

  it('proxyAgent refuses a proxy URL that would resolve DNS here (socks5://, http://)', () => {
    expect(() => proxyAgent('socks5://127.0.0.1:9050', 'x')).toThrow(/socks5h/);
    expect(() => proxyAgent('http://127.0.0.1:9080', 'x')).toThrow(/socks5h/);
    expect(() => proxyAgent('socks5h://127.0.0.1:9050', 'x')).not.toThrow();
  });
});

describe('every outbound path uses its own circuit when network.socks_proxy is set', () => {
  const torConfig = (rpcUrl: string) => {
    const cfg = testConfig();
    cfg.wallet.address = getAddress('0x00000000000000000000000000000000000000aa');
    cfg.network.socks_proxy = socks.url;
    cfg.chains = cfg.chains.map((c) => ({ ...c, rpc_url: rpcUrl }));
    return cfg;
  };

  it('balance reads: circuit "balances", hostname resolved by Tor', async () => {
    const clients = createRpcClients(torConfig(`http://rpc.test:${rpcPort}`));
    expect(await clients.getEthBalance(11155111)).toBe(42n);
    expect(await clients.getUsdcBalance(84532)).toBe(7n);
    expect(socks.connects.map((c) => [c.user, c.atyp, c.host])).toEqual([
      ['balances', 'domain', 'rpc.test'],
      ['balances', 'domain', 'rpc.test'],
    ]);
  });

  it('ENS lookups: circuit "ens", never the balance circuit', async () => {
    const cfg = torConfig(`http://rpc.test:${rpcPort}`);
    await createRpcClients(cfg).getEthBalance(11155111);
    await createEnsClient(cfg)
      .getAddress('riya.eth', 60n)
      .catch(() => null);
    expect(socks.connects.map((c) => c.user)).toEqual(['balances', 'ens']);
    expect(socks.connects[0]?.pass).toBe(socks.connects[1]?.pass); // one process token, two usernames
  });

  it('the ENS indexer: circuit "indexer" by default (no global fetch)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const cfg = torConfig(`http://rpc.test:${rpcPort}`);
    cfg.ens.indexer_url = `https://indexer.test:${tlsPort}/graphql`;
    socks.hosts.set('indexer.test', tlsPort);
    await expect(createSubnameSource(cfg).listChildren('iitr.eth')).rejects.toBeInstanceOf(IndexerUnavailable);
    expect(spy).not.toHaveBeenCalled();
    expect(socks.connects).toEqual([
      expect.objectContaining({ user: 'indexer', atyp: 'domain', host: 'indexer.test' }),
    ]);
    expect(sni).toEqual(['indexer.test']);
  });

  it('links: circuit "links", and no DNS lookup here', async () => {
    const resolve = vi.fn();
    const cfg = torConfig(`http://rpc.test:${rpcPort}`);
    const fetcher = createContentFetcher(cfg, { resolve });
    // The stand-in's certificate isn't trusted, so the read fails; what matters is the route it took.
    expect(await fetcher.fetchUrl(`https://docs.test:${tlsPort}/invoice`)).toEqual({ ok: false });
    expect(resolve).not.toHaveBeenCalled();
    expect(socks.connects).toEqual([expect.objectContaining({ user: 'links', atyp: 'domain', host: 'docs.test' })]);
    expect(sni).toEqual(['docs.test']);
  });

  it('links: private and local addresses are still refused, before anything is sent', async () => {
    const resolve = vi.fn();
    const fetcher = createContentFetcher(torConfig(`http://rpc.test:${rpcPort}`), { resolve });
    for (const url of [
      'https://127.0.0.1/',
      'https://10.0.0.1/',
      'https://[::1]/',
      'https://169.254.169.254/latest',
      'https://localhost/',
      'https://LOCALHOST./',
      'https://api.localhost/',
    ]) {
      expect(await fetcher.fetchUrl(url), url).toEqual({ ok: false });
    }
    expect(socks.connects).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('links: a public IP literal goes to Tor as an address (nothing to resolve)', async () => {
    const fetcher = createContentFetcher(torConfig(`http://rpc.test:${rpcPort}`), { resolve: vi.fn() });
    expect(await fetcher.fetchUrl('https://93.184.216.34/')).toEqual({ ok: false });
    expect(socks.connects).toEqual([expect.objectContaining({ user: 'links', atyp: 'ipv4', host: '93.184.216.34' })]);
  });

  it('links: with the proxy down nothing is fetched (fails closed)', async () => {
    await socks.stop();
    const fetcher = createContentFetcher(torConfig(`http://rpc.test:${rpcPort}`), { resolve: vi.fn() });
    expect(await fetcher.fetchUrl(`https://docs.test:${tlsPort}/`)).toEqual({ ok: false });
    expect(sni).toEqual([]);
  });

  it('without a proxy, links keep the direct path with local DNS and connect-time pinning (unchanged)', async () => {
    const resolve = vi.fn(async () => [{ address: '10.0.0.5', family: 4 }]);
    const fetcher = createContentFetcher({ ...testConfig() }, { resolve });
    expect(await fetcher.fetchUrl('https://docs.example/')).toEqual({ ok: false });
    expect(resolve).toHaveBeenCalledWith('docs.example');
  });
});

describe('hostAllowedViaProxy', () => {
  it.each([
    ['https://docs.example/', true],
    ['https://abcdefghijklmnop.onion/', true],
    ['https://93.184.216.34/', true],
    ['https://127.0.0.1/', false],
    ['https://192.168.0.1/', false],
    ['https://[fe80::1]/', false],
    ['https://localhost/', false],
    ['https://x.localhost/', false],
  ])('%s → %s', (url, ok) => {
    expect(hostAllowedViaProxy(new URL(url))).toBe(ok);
  });
});
