// Implements: §8.2 step 3 URL fetcher — HTTPS GET only, `fetch.timeout_ms`, at most `fetch.max_redirects`
// redirects (each must stay https), body capped at `fetch.max_bytes`, hosts resolving to private / loopback /
// link-local ranges refused (checked before the request and again at connect time, so DNS rebinding cannot slip
// through), accepted types text/html (→ html-to-text), text/plain, application/pdf (→ pdf-parse). Any failure →
// { ok: false } (S1 maps it to URL_FETCH_FAILED). URLs inside fetched content are never fetched (this module
// fetches exactly the URL it is given). §16.4: user-supplied HTTPS URLs are the only hosts it contacts.
// SQ-O-06: every URL about to be requested (the given URL and each redirect target) is secret-scanned first; a hit
// returns `secretRefusal()` without a request.
// Owner: Lane B.

import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { ContentFetcher, FetchResult } from '../contracts/io.js';
import type { Config } from '../contracts/types.js';
import { secretRefusal, urlHasSecret } from '../guard/urls.js';
import { decodeUtf8, htmlToText, pdfToText } from './extract.js';
import { isBlockedIp } from './ssrf.js';

export interface HttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

/** One HTTPS GET without following redirects. */
export type HttpGet = (url: URL, signal: AbortSignal) => Promise<HttpResponse>;

export type ResolveHost = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface FetcherDeps {
  httpGet?: HttpGet;
  resolve?: ResolveHost;
}

const ACCEPTED = new Set(['text/html', 'text/plain', 'application/pdf']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const defaultResolve: ResolveHost = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Connect-time lookup that refuses blocked addresses (pins the check to the address actually dialled). */
function pinnedLookup(resolve: ResolveHost): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolve(hostname).then(
      (addrs) => {
        if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address))) {
          callback(new Error('blocked host'));
          return;
        }
        const first = addrs[0];
        if (options.all) callback(null, addrs);
        else callback(null, first?.address, first?.family);
      },
      (err: unknown) => callback(err),
    );
  }) as unknown as LookupFunction;
}

function nodeHttpsGet(resolve: ResolveHost): HttpGet {
  return (url, signal) =>
    new Promise<HttpResponse>((resolvePromise, reject) => {
      const req = request(
        url,
        {
          method: 'GET',
          lookup: pinnedLookup(resolve),
          signal,
          headers: { accept: 'text/html, text/plain, application/pdf' },
        },
        (res) => {
          const headers: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
          resolvePromise({ status: res.statusCode ?? 0, headers, body: res, destroy: () => res.destroy() });
        },
      );
      req.on('error', reject);
      req.end();
    });
}

async function hostAllowed(url: URL, resolve: ResolveHost): Promise<boolean> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host.length === 0) return false;
  if (isIP(host) !== 0) return !isBlockedIp(host);
  try {
    const addrs = await resolve(host);
    return addrs.length > 0 && !addrs.some((a) => isBlockedIp(a.address));
  } catch {
    return false;
  }
}

async function readCapped(
  body: AsyncIterable<Uint8Array>,
  max: number,
  destroy: () => void,
): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > max) {
      destroy();
      return null;
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Production fetcher (§8.2 step 3). `deps` lets unit tests replace the network and DNS. */
export function createContentFetcher(config: Config, deps: FetcherDeps = {}): ContentFetcher {
  const resolve = deps.resolve ?? defaultResolve;
  const httpGet = deps.httpGet ?? nodeHttpsGet(resolve);
  const { max_bytes, timeout_ms, max_redirects } = config.fetch;

  async function run(raw: string, signal: AbortSignal): Promise<FetchResult> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false };
    }
    for (let redirects = 0; ;) {
      if (urlHasSecret(url.href)) return secretRefusal();
      if (url.protocol !== 'https:') return { ok: false };
      if (url.username !== '' || url.password !== '') return { ok: false };
      if (!(await hostAllowed(url, resolve))) return { ok: false };
      const res = await httpGet(url, signal);
      if (REDIRECTS.has(res.status)) {
        res.destroy();
        const loc = res.headers.location;
        if (loc === undefined) return { ok: false };
        redirects++;
        if (redirects > max_redirects) return { ok: false };
        try {
          url = new URL(loc, url);
        } catch {
          return { ok: false };
        }
        continue;
      }
      if (res.status < 200 || res.status > 299) {
        res.destroy();
        return { ok: false };
      }
      const type = (res.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (!ACCEPTED.has(type)) {
        res.destroy();
        return { ok: false };
      }
      const declared = Number(res.headers['content-length'] ?? '0');
      if (Number.isFinite(declared) && declared > max_bytes) {
        res.destroy();
        return { ok: false };
      }
      const bytes = await readCapped(res.body, max_bytes, () => res.destroy());
      if (bytes === null) return { ok: false };
      if (type === 'application/pdf') return { ok: true, text: await pdfToText(bytes) };
      const text = decodeUtf8(bytes);
      return { ok: true, text: type === 'text/html' ? htmlToText(text) : text };
    }
  }

  return {
    async fetchUrl(url: string): Promise<FetchResult> {
      const signal = AbortSignal.timeout(timeout_ms);
      try {
        return await Promise.race([
          run(url, signal),
          new Promise<FetchResult>((resolveTimeout) => {
            signal.addEventListener('abort', () => resolveTimeout({ ok: false }), { once: true });
          }),
        ]);
      } catch {
        return { ok: false };
      }
    },
  };
}
