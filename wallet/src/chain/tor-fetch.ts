// anon-rpc over Tor for the wallet. With `network.socks_proxy` set, every request to an RPC that isn't on this machine goes
// through Tor's SOCKS port: Tor resolves the hostname (no DNS here), and each chain uses its own SOCKS username, which Tor
// (IsolateSOCKSAuth, on by default) turns into its own circuit. If the proxy can't be reached the request fails; nothing
// ever falls back to a direct connection. Requests to 127.0.0.1 / ::1 (a node on this machine) go direct.
// Connections are kept alive: everything the wallet sends already carries the user's address, and receipt polling every
// 250 ms would otherwise build a new Tor stream each time. JSON-RPC ids are random, not viem's process-wide counter.
// ponytail: a trimmed copy of the agent's src/util/isolated-fetch.ts (the two packages share no code); share it if a third
// copy is ever needed.

import { randomBytes, randomInt } from 'node:crypto';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { SocksProxyAgent } from 'socks-proxy-agent';

const NULL_BODY = new Set([204, 205, 304]);
const PROCESS_TOKEN = randomBytes(8).toString('hex');

// `localhost` too: simulation endpoints may use it (src/chain/simulation.ts), and Tor can't reach this machine anyway.
const isLoopbackHost = (hostname: string): boolean =>
  hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' || hostname === 'localhost';

function randomizeRpcId(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  if (!('jsonrpc' in parsed) || !('id' in parsed)) return body;
  return JSON.stringify({ ...parsed, id: randomInt(2 ** 47) });
}

function toResponse(res: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    for (const v of [value ?? []].flat()) headers.append(name, v);
  }
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 599) throw new Error(`unexpected HTTP status ${status}`);
  return new Response(NULL_BODY.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
    status,
    headers,
  });
}

/** The SOCKS agent for one isolation class (`socks5h` only, so Tor resolves hostnames). */
export function torAgent(proxy: string, isolation: string): SocksProxyAgent {
  const url = new URL(proxy);
  if (url.protocol !== 'socks5h:') throw new Error('the proxy must be socks5h:// so the proxy resolves hostnames');
  url.username = encodeURIComponent(isolation);
  url.password = PROCESS_TOKEN;
  return new SocksProxyAgent(url, { keepAlive: true });
}

/** A `fetch` for viem's http transport: Tor for remote hosts when `proxy` is set, random JSON-RPC ids, no redirects. */
export function torFetch(proxy: string | null, isolation: string): typeof fetch {
  const direct = { 'http:': new HttpAgent({ keepAlive: true }), 'https:': new HttpsAgent({ keepAlive: true }) };
  const tor = proxy === null ? null : torAgent(proxy, isolation);
  const fetchFn = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        reject(new TypeError(`unsupported protocol ${url.protocol}`));
        return;
      }
      const body = typeof init.body === 'string' ? randomizeRpcId(init.body) : undefined;
      const headers = Object.fromEntries(new Headers(init.headers));
      if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
      const agent = tor !== null && !isLoopbackHost(url.hostname) ? tor : direct[url.protocol];
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(
        url,
        { method: init.method ?? 'GET', headers, agent, signal: init.signal ?? undefined },
        (res) => {
          try {
            resolve(toResponse(res));
          } catch (e) {
            res.destroy();
            reject(e);
          }
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  return fetchFn as typeof fetch;
}
