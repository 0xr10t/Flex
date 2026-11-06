// Privacy fix 7 and the Tor option (anon-rpc). A fetch for one kind of outbound query ("isolation": balances, ens, indexer,
// links). With `network.socks_proxy` set, every request to a host that isn't this machine goes through Tor's SOCKS port:
// the hostname is sent to Tor (DNS never happens here), and each isolation class uses its own SOCKS username, which Tor
// (IsolateSOCKSAuth, on by default) turns into its own circuit. A proxied request opens a new stream each time (no
// keep-alive), so one long-lived connection can't tie lookups together; Tor still reuses a class's circuit for up to 10
// minutes. If the proxy can't be reached the request fails: nothing ever falls back to a direct connection. Requests to
// 127.0.0.1 / ::1 (a node on this machine) go direct, each class with its own keep-alive pool.
// JSON-RPC ids are replaced with random ones (viem numbers every request in the process from one counter, which links
// them). Redirects are not followed.

import { randomBytes, randomInt } from 'node:crypto';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { http, type Transport } from 'viem';

/** Statuses whose Response must have no body. */
const NULL_BODY = new Set([204, 205, 304]);

/** Random per process, so two runs never share a circuit. */
const PROCESS_TOKEN = randomBytes(8).toString('hex');

export interface NetOptions {
  /** `socks5h://127.0.0.1:<port>` (Tor), or null for direct connections. */
  proxy: string | null;
  /** The kind of query; one Tor circuit per kind. */
  isolation: string;
}

/** 127.0.0.1 or ::1: a service on this machine, reached directly. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/** The SOCKS agent for one isolation class: Tor resolves the hostname, and the username picks the circuit. */
export function proxyAgent(proxy: string, isolation: string): SocksProxyAgent {
  const url = new URL(proxy);
  if (url.protocol !== 'socks5h:') throw new Error('the proxy must be socks5h:// so the proxy resolves hostnames');
  url.username = encodeURIComponent(isolation);
  url.password = PROCESS_TOKEN;
  return new SocksProxyAgent(url);
}

/**
 * A single JSON-RPC request with its id replaced by a random one; any other body is returned unchanged. viem doesn't
 * match response ids for single requests.
 * ponytail: batches are left as they are; viem's batching is off everywhere in this code. Randomise them if it's turned on.
 */
export function randomizeRpcId(body: string): string {
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
  const body = NULL_BODY.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
  return new Response(body, { status, headers });
}

/** A `fetch` (e.g. viem's `fetchFn`) for one isolation class: Tor for remote hosts when configured, random JSON-RPC ids. */
export function isolatedFetch(o: NetOptions = { proxy: null, isolation: 'direct' }): typeof fetch {
  const direct = { 'http:': new HttpAgent({ keepAlive: true }), 'https:': new HttpsAgent({ keepAlive: true }) };
  const tor = o.proxy === null ? null : proxyAgent(o.proxy, o.isolation);
  const isolated = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
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
  return isolated as typeof fetch;
}

/** viem HTTP transports for one isolation class (§14.5: no retries). */
export function isolatedHttp(timeout: number, net: NetOptions): (url: string) => Transport {
  const fetchFn = isolatedFetch(net);
  return (url) => http(url, { timeout, retryCount: 0, fetchFn });
}
