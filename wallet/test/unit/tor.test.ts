// anon-rpc over Tor in the wallet, against a stand-in SOCKS5 server and a local JSON-RPC server. `rpc.test` can't be
// resolved here, so a request only works if Tor (the stand-in) resolves it.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChainUnavailableError, SimulationUnavailableError, createChainGateway } from '../../src/chain/gateway.js';
import { createSimulator } from '../../src/chain/simulation.js';
import { torAgent } from '../../src/chain/tor-fetch.js';
import { silentLogger } from '../../src/log.js';
import { createService } from '../../src/service.js';
import { ALEX, ARBITRUM, BASE, DB_KEY, envelope, payEth } from '../support/envelopes.js';
import { FakeSocks } from '../support/socks-server.js';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const BLOCK = {
  number: '0x64',
  hash: `0x${'ab'.repeat(32)}`,
  parentHash: `0x${'cd'.repeat(32)}`,
  timestamp: '0x3e8',
  transactions: [],
};
const ANCHOR = { number: BLOCK.number, hash: BLOCK.hash, timestamp: BLOCK.timestamp };
const CALL = { from: ALEX, to: ALEX, data: '0x' as const };

let socks: FakeSocks;
let rpc: Server;
let rpcPort: number;
let methods: string[];

beforeEach(async () => {
  socks = await new FakeSocks().start();
  methods = [];
  rpc = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as { id: number; method: string };
      methods.push(body.method);
      const answers: Record<string, unknown> = {
        eth_getCode: '0x',
        eth_sendRawTransaction: `0x${'ab'.repeat(32)}`,
        eth_chainId: '0x14a34',
        eth_getBlockByNumber: BLOCK,
        eth_simulateV1: [{ calls: [{ status: '0x1', gasUsed: '0x5208', logs: [] }] }],
      };
      const result = answers[body.method] ?? '0x5';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', r));
  rpcPort = (rpc.address() as AddressInfo).port;
  socks.hosts.set('rpc.test', rpcPort);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await socks.stop();
  rpc.closeAllConnections();
  await new Promise<void>((r) => rpc.close(() => r()));
});

const remote = () => `http://rpc.test:${rpcPort}`;
/** Simulators must be https or on this machine; a local one keeps these tests about the read RPC. */
const localSim = () => ({ rpc_urls: [`http://127.0.0.1:${rpcPort}/sim`], quorum: 1 });

describe('the chain gateway through Tor', () => {
  it('reads go through the proxy with the hostname (no DNS here), on the circuit for that chain', async () => {
    const gw = createChainGateway(BASE, remote(), account, localSim(), socks.url);
    expect(await gw.getCode(ALEX)).toBeUndefined();
    expect(await gw.minedNonce()).toBe(5);
    expect(methods).toEqual(['eth_getCode', 'eth_getTransactionCount']);
    expect(socks.connects.length).toBeGreaterThan(0);
    for (const c of socks.connects)
      expect(c).toMatchObject({ user: `wallet-${BASE}`, atyp: 'domain', host: 'rpc.test' });
  });

  it('a signed transaction is broadcast through Tor too', async () => {
    const gw = createChainGateway(BASE, remote(), account, localSim(), socks.url);
    await gw.broadcast('0x02f8');
    expect(methods).toEqual(['eth_sendRawTransaction']);
    expect(socks.connects[0]).toMatchObject({ user: `wallet-${BASE}`, host: 'rpc.test' });
  });

  it('each chain has its own circuit (SOCKS username), with one process token', async () => {
    await createChainGateway(BASE, remote(), account, localSim(), socks.url).getCode(ALEX);
    await createChainGateway(ARBITRUM, remote(), account, localSim(), socks.url).getCode(ALEX);
    expect(new Set(socks.connects.map((c) => c.user))).toEqual(new Set([`wallet-${BASE}`, `wallet-${ARBITRUM}`]));
    expect(new Set(socks.connects.map((c) => c.pass)).size).toBe(1);
  });

  it('keeps its Tor connection alive between requests (receipt polling would otherwise open a stream each time)', async () => {
    const gw = createChainGateway(BASE, remote(), account, localSim(), socks.url);
    for (let i = 0; i < 4; i++) await gw.minedNonce();
    expect(methods).toHaveLength(4);
    expect(socks.connects).toHaveLength(1);
  });

  it('fails closed: with the proxy down the chain is unavailable and nothing reaches the RPC', async () => {
    await socks.stop();
    const gw = createChainGateway(BASE, remote(), account, localSim(), socks.url);
    await expect(gw.getCode(ALEX)).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(gw.broadcast('0x02f8')).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(methods).toEqual([]);
  });

  it('a node on this machine (127.0.0.1) is reached directly', async () => {
    const gw = createChainGateway(BASE, `http://127.0.0.1:${rpcPort}`, account, undefined, socks.url);
    await gw.getCode(ALEX);
    expect(socks.connects).toEqual([]);
    expect(methods).toEqual(['eth_getCode']);
  });

  it('without a proxy, the gateway connects directly (null)', async () => {
    const gw = createChainGateway(BASE, `http://127.0.0.1:${rpcPort}`, account, undefined, null);
    await gw.getCode(ALEX);
    expect(socks.connects).toEqual([]);
  });

  it('never uses the global fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await createChainGateway(BASE, remote(), account, localSim(), socks.url).getCode(ALEX);
    expect(spy).not.toHaveBeenCalled();
  });

  it('torAgent refuses a proxy URL that would resolve DNS here', () => {
    expect(() => torAgent('socks5://127.0.0.1:9050', 'x')).toThrow(/socks5h/);
    expect(() => torAgent('socks5h://127.0.0.1:9050', 'x')).not.toThrow();
  });
});

describe('simulation providers through Tor', () => {
  it('each simulation provider is reached through Tor on its own circuit, hostname resolved by Tor', async () => {
    const simulate = createSimulator(
      BASE,
      { rpc_urls: ['https://sim-a.test/rpc', 'https://sim-b.test/rpc'], quorum: 2 },
      socks.url,
    );
    // The stand-in can't reach these hosts, so the quorum fails; the route is what matters.
    await expect(simulate([{ calls: [CALL] }], ANCHOR)).rejects.toThrow();
    expect(socks.connects.map((c) => [c.user, c.atyp, c.host]).sort()).toEqual([
      [`wallet-sim-${BASE}-0`, 'domain', 'sim-a.test'],
      [`wallet-sim-${BASE}-1`, 'domain', 'sim-b.test'],
    ]);
    expect(methods).toEqual([]);
  });

  it('a simulator on this machine is reached directly, and the quorum still works end to end', async () => {
    const simulate = createSimulator(
      BASE,
      { rpc_urls: [`http://127.0.0.1:${rpcPort}/a`, `http://127.0.0.1:${rpcPort}/b`], quorum: 2 },
      socks.url,
    );
    expect(await simulate([{ calls: [CALL] }], ANCHOR)).toEqual([[{ status: 'success', logs: [] }]]);
    expect(socks.connects).toEqual([]);
    expect(methods.filter((m) => m === 'eth_simulateV1')).toHaveLength(2);
  });

  it('fails closed: with the proxy down no simulator is contacted', async () => {
    await socks.stop();
    const simulate = createSimulator(BASE, { rpc_urls: ['https://sim-a.test/rpc'], quorum: 1 }, socks.url);
    await expect(simulate([{ calls: [CALL] }], ANCHOR)).rejects.toThrow();
    expect(methods).toEqual([]);
  });

  it('the gateway reads the anchor on the chain circuit and simulates on the simulator circuit', async () => {
    const gw = createChainGateway(
      BASE,
      remote(),
      account,
      { rpc_urls: ['https://sim-a.test/rpc'], quorum: 1 },
      socks.url,
    );
    await expect(gw.simulate([{ calls: [CALL] }])).rejects.toBeInstanceOf(SimulationUnavailableError);
    expect(socks.connects.map((c) => c.user)).toEqual([`wallet-${BASE}`, `wallet-sim-${BASE}-0`]);
    expect(methods).toEqual(['eth_getBlockByNumber']);
  });
});

describe('the service wires network.socks_proxy into every chain', () => {
  it('a request handled by the running wallet reaches the RPC only through Tor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flex-wallet-tor-'));
    const service = createService(
      {
        server: { host: '127.0.0.1', port: 0 },
        agent: { url: 'http://127.0.0.1:9' },
        auth: { inbound_token_file: '/unused', report_token_file: '/unused' },
        db: { path: join(dir, 'wallet.db') },
        approval: { mode: 'reject_all' },
        network: { socks_proxy: socks.url },
        chains: [{ chain_id: BASE, rpc_url: remote(), simulation: localSim() }],
      },
      { account, dbKeyHex: DB_KEY, inboundToken: 'in', reportToken: 'rep' },
      silentLogger,
    );
    service.store.insertRequest(envelope([payEth(0, [[ALEX, '0.01']])]), '2026-11-06T10:00:00.000Z');
    await service.start();
    await vi.waitFor(() => expect(methods.length).toBeGreaterThan(0), { timeout: 5000 });
    await service.stop();
    expect(socks.connects.length).toBeGreaterThan(0);
    for (const c of socks.connects)
      expect(c).toMatchObject({ user: `wallet-${BASE}`, atyp: 'domain', host: 'rpc.test' });
  });
});
