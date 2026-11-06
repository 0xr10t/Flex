// Privacy fix 7: a fetch for one kind of outbound query (balances, ens). Each instance keeps its own keep-alive
// connection pool, so balance reads (your address) and ENS lookups (the names you pay) never share a connection to the
// RPC. JSON-RPC ids are replaced with random ones (viem numbers every request in the process from one counter, which
// links them). Redirects are not followed: an RPC that redirects is refused, not followed somewhere else.

import { randomInt } from 'node:crypto';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { http, type Transport } from 'viem';

/** Statuses whose Response must have no body. */
const NULL_BODY = new Set([204, 205, 304]);

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

/** A `fetch` (e.g. viem's `fetchFn`) with its own keep-alive pool and random JSON-RPC ids. One per kind of query. */
export function isolatedFetch(): typeof fetch {
  const agents = { 'http:': new HttpAgent({ keepAlive: true }), 'https:': new HttpsAgent({ keepAlive: true }) };
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
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(
        url,
        { method: init.method ?? 'GET', headers, agent: agents[url.protocol], signal: init.signal ?? undefined },
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

/** viem HTTP transports that share one isolated pool (§14.5: no retries). Call once per kind of query. */
export function isolatedHttp(timeout: number): (url: string) => Transport {
  const fetchFn = isolatedFetch();
  return (url) => http(url, { timeout, retryCount: 0, fetchFn });
}
