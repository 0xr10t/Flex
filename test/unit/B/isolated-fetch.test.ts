// Privacy fix 7: isolatedFetch against a real local HTTP server. Each instance keeps its own connections, JSON-RPC ids are
// random, redirects are not followed, and the global fetch is never used.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, getAddress, http } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isolatedFetch, randomizeRpcId } from '../../../src/util/isolated-fetch.js';

interface Seen {
  port: number;
  body: { id?: unknown; method?: string };
  headers: IncomingMessage['headers'];
}

let server: Server;
let base: string;
let seen: Seen[];
let reply: (body: Seen['body']) => { status?: number; headers?: Record<string, string>; text: string };

beforeEach(async () => {
  seen = [];
  reply = (body) => ({ text: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x1' }) });
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = raw === '' ? {} : (JSON.parse(raw) as Seen['body']);
      seen.push({ port: req.socket.remotePort as number, body, headers: req.headers });
      const r = reply(body);
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
      res.end(r.text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (f: typeof fetch, id: number) =>
  f(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_chainId', params: [] }),
  });

describe('randomizeRpcId', () => {
  it('replaces the id of a single request and keeps everything else', () => {
    const out = JSON.parse(randomizeRpcId('{"jsonrpc":"2.0","id":7,"method":"eth_call","params":[1]}'));
    expect(out).toMatchObject({ jsonrpc: '2.0', method: 'eth_call', params: [1] });
    expect(Number.isInteger(out.id)).toBe(true);
  });

  it('gives different ids to the same request', () => {
    const ids = new Set(Array.from({ length: 50 }, () => JSON.parse(randomizeRpcId('{"jsonrpc":"2.0","id":0}')).id));
    expect(ids.size).toBe(50);
  });

  it('leaves bodies that are not one JSON-RPC request unchanged (no id, batches, GraphQL, not JSON)', () => {
    expect(randomizeRpcId('{"jsonrpc":"2.0","method":"x"}')).toBe('{"jsonrpc":"2.0","method":"x"}');
    expect(randomizeRpcId('[{"jsonrpc":"2.0","id":1}]')).toBe('[{"jsonrpc":"2.0","id":1}]');
    expect(randomizeRpcId('{"query":"{ x }","id":3}')).toBe('{"query":"{ x }","id":3}');
    expect(randomizeRpcId('not json')).toBe('not json');
  });
});

describe('isolatedFetch over a real socket', () => {
  it('sends the JSON-RPC body with a random id and returns the response', async () => {
    const f = isolatedFetch();
    const res = await post(f, 0);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: '0x1' });
    expect(seen[0]?.body.method).toBe('eth_chainId');
    expect(seen[0]?.body.id).not.toBe(0);
    expect(seen[0]?.headers['content-length']).toBe(String(Buffer.byteLength(JSON.stringify(seen[0]?.body))));
  });

  it('ids sent in a row are not sequential', async () => {
    const f = isolatedFetch();
    for (let i = 0; i < 5; i++) await (await post(f, i)).text();
    const ids = seen.map((s) => s.body.id as number);
    expect(new Set(ids).size).toBe(5);
    expect(ids.slice(1).every((id, i) => id !== (ids[i] as number) + 1)).toBe(true);
  });

  it('one instance reuses its connection; two instances never share one', async () => {
    const balances = isolatedFetch();
    const ens = isolatedFetch();
    await (await post(balances, 1)).text();
    await (await post(balances, 2)).text();
    await (await post(ens, 3)).text();
    await (await post(ens, 4)).text();
    const [b1, b2, e1, e2] = seen.map((s) => s.port);
    expect(b1).toBe(b2);
    expect(e1).toBe(e2);
    expect(e1).not.toBe(b1);
  });

  it('never calls the global fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await (await post(isolatedFetch(), 1)).text();
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not follow a redirect', async () => {
    reply = () => ({ status: 302, headers: { location: 'https://elsewhere.invalid/' }, text: '' });
    const res = await post(isolatedFetch(), 1);
    expect(res.status).toBe(302);
    expect(seen).toHaveLength(1);
  });

  it('passes HTTP errors through as a response', async () => {
    reply = () => ({ status: 500, text: 'boom' });
    const res = await post(isolatedFetch(), 1);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('boom');
  });

  it('rejects when the request is aborted', async () => {
    reply = () => ({ text: '' });
    server.removeAllListeners('request');
    server.on('request', () => {}); // never answers
    const ctrl = new AbortController();
    const p = isolatedFetch()(base, { method: 'POST', body: '{"id":1}', signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toThrow();
  });

  it('rejects a connection failure', async () => {
    await expect(isolatedFetch()('http://127.0.0.1:1/', { method: 'POST', body: '{"id":1}' })).rejects.toThrow();
  });

  it('refuses a protocol other than http(s)', async () => {
    await expect(isolatedFetch()('ftp://127.0.0.1/', {})).rejects.toBeInstanceOf(TypeError);
  });

  it('works as viem http transport fetchFn end to end', async () => {
    reply = (body) => ({ text: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0xde0b6b3a7640000' }) });
    const client = createPublicClient({
      transport: http(base, { fetchFn: isolatedFetch(), retryCount: 0 }),
      ccipRead: false,
    });
    const balance = await client.getBalance({ address: getAddress('0x00000000000000000000000000000000000000aa') });
    expect(balance).toBe(10n ** 18n);
    expect(seen[0]?.body.method).toBe('eth_getBalance');
  });

  it('viem accepts a response whose id differs from the one viem picked', async () => {
    reply = () => ({ text: JSON.stringify({ jsonrpc: '2.0', id: 123456, result: '0x5' }) });
    const client = createPublicClient({ transport: http(base, { fetchFn: isolatedFetch(), retryCount: 0 }) });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(5n);
  });
});
