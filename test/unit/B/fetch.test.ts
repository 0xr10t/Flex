// Tests: §8.2 step 3 content fetcher and SSRF guard — C-069 (https GET, timeout, max_redirects each https, max_bytes),
// C-070 (the eight refused ranges + SQB-12 0.0.0.0/8, ::, IPv4-mapped), C-071 (text/html via html-to-text, text/plain,
// application/pdf; other types refused), C-072 (any failure → { ok: false }), C-409 (§16.4: only the given https URL
// is contacted). No network: the fetcher's `httpGet` and `resolve` seams are stubbed.
import { describe, expect, it } from 'vitest';
import {
  createContentFetcher,
  type HttpGet,
  type HttpResponse,
  type ResolveHost,
} from '../../../src/quarantine/fetch.js';
import { isSecretRefusal } from '../../../src/guard/urls.js';
import { isBlockedIp } from '../../../src/quarantine/ssrf.js';
import { testConfig } from '../../fakes/context.js';
import { tinyPdf } from './helpers.js';

const enc = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));
const PUBLIC: ResolveHost = async () => [{ address: '93.184.216.34', family: 4 }];

function resp(
  status: number,
  headers: Record<string, string>,
  body: Uint8Array | Uint8Array[] = new Uint8Array(),
): HttpResponse {
  const chunks = Array.isArray(body) ? body : [body];
  return {
    status,
    headers,
    body: (async function* () {
      for (const c of chunks) yield c;
    })(),
    destroy: () => undefined,
  };
}

function setup(
  responses: Record<string, HttpResponse | ((u: URL) => HttpResponse)>,
  opts: { resolve?: ResolveHost; max_bytes?: number; max_redirects?: number; timeout_ms?: number } = {},
) {
  const cfg = testConfig();
  cfg.fetch = {
    max_bytes: opts.max_bytes ?? 1000,
    timeout_ms: opts.timeout_ms ?? 2000,
    max_redirects: opts.max_redirects ?? 3,
  };
  const requested: string[] = [];
  const resolved: string[] = [];
  const httpGet: HttpGet = async (url) => {
    requested.push(url.href);
    const r = responses[url.href];
    if (!r) throw new Error(`unexpected request ${url.href}`);
    return typeof r === 'function' ? r(url) : r;
  };
  const base = opts.resolve ?? PUBLIC;
  const resolve: ResolveHost = async (h) => {
    resolved.push(h);
    return base(h);
  };
  return { fetcher: createContentFetcher(cfg, { httpGet, resolve }), requested, resolved };
}

describe('SSRF range check (§8.2 step 3, C-070, SQB-12)', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.255',
    '10.0.0.1',
    '10.255.255.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '0.1.2.3',
    '::1',
    '::',
    'fc00::1',
    'fdff:ffff::1',
    'fe80::1',
    'febf::1',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
    '::ffff:7f00:1',
    '[::1]',
    'not-an-ip',
    'fec0::1', // SQ-O-08: site-local now refused
  ])('refuses %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '172.15.255.255',
    '172.32.0.1',
    '192.167.1.1',
    '169.253.1.1',
    '11.0.0.1',
    '2606:4700:4700::1111',
    'fbff::1',
    '::ffff:8.8.8.8',
  ])('allows %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe('SSRF additional ranges (SQ-O-08, F-13)', () => {
  it.each([
    '100.64.0.0',
    '100.64.0.1',
    '100.127.255.255', // 100.64.0.0/10
    '192.0.0.0',
    '192.0.0.255', // 192.0.0.0/24
    '198.18.0.0',
    '198.19.255.255', // 198.18.0.0/15
    '224.0.0.0',
    '239.255.255.255',
    '255.255.255.255', // multicast, broadcast
    'ff00::',
    'ff02::1',
    'ffff::1', // ff00::/8
    'fec0::',
    'fec0::1',
    'feff::1', // fec0::/10
    '64:ff9b::',
    '64:ff9b::7f00:1',
    '64:ff9b::808:808',
    '64:ff9b::ffff:ffff', // F-13 NAT64 entirely
    '2002::',
    '2002:808:808::1',
    '2002:7f00:1::1',
    '2002:ffff::1', // F-13 6to4 entirely
    '::7f00:1',
    '::a00:1',
    '::127.0.0.1',
    '::192.168.1.1', // IPv4-compatible, decoded
    '::ffff:100.64.0.1', // IPv4-mapped into a new range
  ])('SQ-O-08 / F-13 refuses %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '100.63.255.255',
    '100.128.0.0',
    '100.128.0.1', // just outside 100.64.0.0/10
    '192.0.1.1',
    '191.255.255.255', // just outside 192.0.0.0/24
    '198.17.255.255',
    '198.20.0.0',
    '198.20.0.1', // just outside 198.18.0.0/15
    '223.255.255.255', // just below multicast
    'fe00::1', // outside fec0::/10 and fe80::/10
    '64:ff9a::1',
    '64:ff9c::1', // neighbours of 64:ff9b::/96
    '2001:ffff::1',
    '2003::1', // neighbours of 2002::/16
    '::8.8.8.8',
    '::808:808', // IPv4-compatible of a public address
    '::ffff:8.8.8.8',
  ])('SQ-O-08 / F-13 allows boundary address %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it.each(['240.0.0.1', '255.255.255.254'])('SQ-O-08: only 255.255.255.255 is refused, not 240.0.0.0/4 (%s)', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it.each(['100.64.0.1', '64:ff9b::808:808', '2002:808:808::1', '224.0.0.1', 'ff02::1'])(
    'SQ-O-08 / F-13 fetcher refuses a host resolving to %s at the pre-check (no request)',
    async (addr) => {
      const { fetcher, requested } = setup(
        { 'https://h.example.com/': resp(200, { 'content-type': 'text/plain' }, enc('x')) },
        { resolve: async () => [{ address: addr, family: addr.includes(':') ? 6 : 4 }] },
      );
      expect(await fetcher.fetchUrl('https://h.example.com/')).toEqual({ ok: false });
      expect(requested).toEqual([]);
    },
  );

  it.each(['100.64.0.1', '64:ff9b::808:808'])(
    'SQ-O-08 / F-13 DNS rebinding: public at the pre-check, %s at connect time -> refused',
    async (addr) => {
      let n = 0;
      const cfg = testConfig();
      const f = createContentFetcher(cfg, {
        resolve: async () =>
          ++n === 1
            ? [{ address: '93.184.216.34', family: 4 }]
            : [{ address: addr, family: addr.includes(':') ? 6 : 4 }],
      });
      expect(await f.fetchUrl('https://rebind.example.com/')).toEqual({ ok: false });
      expect(n).toBe(2);
    },
  );
});

describe('fetcher secret scan (SQ-O-06)', () => {
  const HEX = 'ab'.repeat(32);
  it('SQ-O-06 a URL carrying a key is never requested', async () => {
    const { fetcher, requested } = setup({});
    const r = await fetcher.fetchUrl(`https://a.example.com/?k=${HEX}`);
    expect(isSecretRefusal(r)).toBe(true);
    expect(requested).toEqual([]);
  });

  it('SQ-O-06 a redirect target carrying a key (also percent-encoded seed) is never requested; exactly one request made', async () => {
    for (const loc of [
      `https://b.example.com/?k=${HEX}`,
      '/x?m=abandon%20ability%20able%20about%20above%20absent%20absorb%20abstract%20absurd%20abuse%20access%20accident',
    ]) {
      const { fetcher, requested } = setup({ 'https://a.example.com/': resp(302, { location: loc }) });
      const r = await fetcher.fetchUrl('https://a.example.com/');
      expect(isSecretRefusal(r)).toBe(true);
      expect(requested).toEqual(['https://a.example.com/']);
    }
  });

  it('SQ-O-06 a clean redirect is still followed and an ordinary failure is not a secret refusal', async () => {
    const { fetcher, requested } = setup({
      'https://a.example.com/': resp(302, { location: 'https://b.example.com/' }),
      'https://b.example.com/': resp(200, { 'content-type': 'text/plain' }, enc('ok')),
    });
    expect(await fetcher.fetchUrl('https://a.example.com/')).toEqual({ ok: true, text: 'ok' });
    expect(requested).toHaveLength(2);
    const bad = setup({ 'https://a.example.com/': resp(500, {}) });
    const r = await bad.fetcher.fetchUrl('https://a.example.com/');
    expect(r).toEqual({ ok: false });
    expect(isSecretRefusal(r)).toBe(false);
  });
});

describe('content fetcher (§8.2 step 3, C-069, C-071, C-072)', () => {
  it('only https: http:// and other schemes and credentials in the URL are refused, with no request', async () => {
    const { fetcher, requested } = setup({});
    for (const u of [
      'http://a.example/',
      'ftp://a.example/',
      'file:///etc/passwd',
      'https://user:pw@a.example/',
      'garbage',
    ])
      expect(await fetcher.fetchUrl(u)).toEqual({ ok: false });
    expect(requested).toEqual([]);
  });

  it('refuses hosts that resolve to private ranges (any address of several), literal IPs, and DNS failure — before any request', async () => {
    const mixed: ResolveHost = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    const a = setup({}, { resolve: mixed });
    expect(await a.fetcher.fetchUrl('https://rebind.example/')).toEqual({ ok: false });
    const b = setup({}, { resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    expect(await b.fetcher.fetchUrl('https://localhost.example/')).toEqual({ ok: false });
    const c = setup({});
    for (const u of [
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://169.254.169.254/latest',
      'https://[fe80::1]/',
      'https://[::ffff:10.0.0.1]/',
      'https://192.168.0.9/',
    ])
      expect(await c.fetcher.fetchUrl(u)).toEqual({ ok: false });
    expect(c.resolved).toEqual([]);
    const d = setup(
      {},
      {
        resolve: async () => {
          throw new Error('NXDOMAIN');
        },
      },
    );
    expect(await d.fetcher.fetchUrl('https://nx.example/')).toEqual({ ok: false });
    expect(a.requested.concat(b.requested, c.requested, d.requested)).toEqual([]);
  });

  it('accepts text/plain, decodes UTF-8', async () => {
    const { fetcher } = setup({
      'https://a.example/': resp(200, { 'content-type': 'text/plain; charset=utf-8' }, enc('héllo 5 usdc')),
    });
    expect(await fetcher.fetchUrl('https://a.example/')).toEqual({ ok: true, text: 'héllo 5 usdc' });
  });

  it('accepts text/html and converts it with html-to-text', async () => {
    const html = '<html><body><h1>Invoice</h1><p>Pay <b>5</b> USDC</p><script>evil()</script></body></html>';
    const { fetcher } = setup(
      { 'https://a.example/': resp(200, { 'content-type': 'text/html' }, enc(html)) },
      { max_bytes: 5000 },
    );
    const r = await fetcher.fetchUrl('https://a.example/');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('Pay 5 USDC');
      expect(r.text).not.toContain('<');
    }
  });

  it('accepts application/pdf via pdf-parse', async () => {
    const { fetcher } = setup(
      { 'https://a.example/': resp(200, { 'content-type': 'application/pdf' }, tinyPdf('Pay Riya 5 USDC')) },
      { max_bytes: 100000 },
    );
    const r = await fetcher.fetchUrl('https://a.example/');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain('Pay Riya 5 USDC');
  });

  it.each(['application/json', 'image/png', 'application/octet-stream', 'text/xml', ''])(
    'refuses content type %j',
    async (ct) => {
      const { fetcher } = setup({ 'https://a.example/': resp(200, ct ? { 'content-type': ct } : {}, enc('x')) });
      expect(await fetcher.fetchUrl('https://a.example/')).toEqual({ ok: false });
    },
  );

  it('refuses non-2xx responses', async () => {
    for (const status of [199, 301 + 100, 404, 500]) {
      const { fetcher } = setup({ 'https://a.example/': resp(status, { 'content-type': 'text/plain' }, enc('x')) });
      expect(await fetcher.fetchUrl('https://a.example/'), String(status)).toEqual({ ok: false });
    }
  });

  it('body cap max_bytes: exactly max_bytes passes, one more byte fails (streamed, no content-length)', async () => {
    const ok = setup(
      { 'https://a.example/': resp(200, { 'content-type': 'text/plain' }, [enc('a'.repeat(60)), enc('b'.repeat(40))]) },
      { max_bytes: 100 },
    );
    expect(await ok.fetcher.fetchUrl('https://a.example/')).toMatchObject({ ok: true });
    const over = setup(
      { 'https://a.example/': resp(200, { 'content-type': 'text/plain' }, [enc('a'.repeat(60)), enc('b'.repeat(41))]) },
      { max_bytes: 100 },
    );
    expect(await over.fetcher.fetchUrl('https://a.example/')).toEqual({ ok: false });
  });

  it('refuses a declared content-length above max_bytes', async () => {
    const { fetcher } = setup(
      { 'https://a.example/': resp(200, { 'content-type': 'text/plain', 'content-length': '101' }, enc('x')) },
      { max_bytes: 100 },
    );
    expect(await fetcher.fetchUrl('https://a.example/')).toEqual({ ok: false });
  });

  it('follows at most max_redirects redirects (3 ok, 4 fail), re-checking the host each time', async () => {
    const chain = (n: number) => {
      const m: Record<string, HttpResponse> = {};
      for (let i = 0; i < n; i++) m[`https://h${i}.example/`] = resp(302, { location: `https://h${i + 1}.example/` });
      m[`https://h${n}.example/`] = resp(200, { 'content-type': 'text/plain' }, enc('end'));
      return m;
    };
    const ok = setup(chain(3), { max_redirects: 3 });
    expect(await ok.fetcher.fetchUrl('https://h0.example/')).toEqual({ ok: true, text: 'end' });
    expect(ok.resolved).toEqual(['h0.example', 'h1.example', 'h2.example', 'h3.example']);
    const bad = setup(chain(4), { max_redirects: 3 });
    expect(await bad.fetcher.fetchUrl('https://h0.example/')).toEqual({ ok: false });
    const zero = setup(chain(1), { max_redirects: 0 });
    expect(await zero.fetcher.fetchUrl('https://h0.example/')).toEqual({ ok: false });
  });

  it('every redirect hop must stay https and public; relative Location resolves against the current URL', async () => {
    const toHttp = setup({ 'https://a.example/': resp(301, { location: 'http://a.example/next' }) });
    expect(await toHttp.fetcher.fetchUrl('https://a.example/')).toEqual({ ok: false });
    expect(toHttp.requested).toEqual(['https://a.example/']);

    const toPrivate = setup({ 'https://a.example/': resp(307, { location: 'https://169.254.169.254/meta' }) });
    expect(await toPrivate.fetcher.fetchUrl('https://a.example/')).toEqual({ ok: false });
    expect(toPrivate.requested).toEqual(['https://a.example/']);

    const noLoc = setup({ 'https://a.example/': resp(302, {}) });
    expect(await noLoc.fetcher.fetchUrl('https://a.example/')).toEqual({ ok: false });

    const rel = setup({
      'https://a.example/dir/x': resp(302, { location: '../final' }),
      'https://a.example/final': resp(200, { 'content-type': 'text/plain' }, enc('ok')),
    });
    expect(await rel.fetcher.fetchUrl('https://a.example/dir/x')).toEqual({ ok: true, text: 'ok' });
  });

  it('timeout: a request that never answers resolves { ok: false } after fetch.timeout_ms', async () => {
    const cfg = testConfig();
    cfg.fetch = { max_bytes: 1000, timeout_ms: 60, max_redirects: 3 };
    const fetcher = createContentFetcher(cfg, {
      resolve: PUBLIC,
      httpGet: () => new Promise<HttpResponse>(() => undefined),
    });
    const t0 = Date.now();
    expect(await fetcher.fetchUrl('https://slow.example/')).toEqual({ ok: false });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('timeout while streaming the body also fails', async () => {
    const cfg = testConfig();
    cfg.fetch = { max_bytes: 1000, timeout_ms: 60, max_redirects: 3 };
    const slow: HttpResponse = {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: (async function* () {
        yield enc('a');
        await new Promise((r) => setTimeout(r, 400));
        yield enc('b');
      })(),
      destroy: () => undefined,
    };
    const fetcher = createContentFetcher(cfg, { resolve: PUBLIC, httpGet: async () => slow });
    expect(await fetcher.fetchUrl('https://slow.example/')).toEqual({ ok: false });
  });

  it('a network error from httpGet → { ok: false } (never throws)', async () => {
    const fetcher = createContentFetcher(testConfig(), {
      resolve: PUBLIC,
      httpGet: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect(await fetcher.fetchUrl('https://a.example/')).toEqual({ ok: false });
  });

  it('C-409/C-072: fetches exactly the URL given; links inside the body are not followed', async () => {
    const { fetcher, requested } = setup({
      'https://a.example/': resp(
        200,
        { 'content-type': 'text/plain' },
        enc('see https://b.example/ and https://c.example/'),
      ),
    });
    await fetcher.fetchUrl('https://a.example/');
    expect(requested).toEqual(['https://a.example/']);
  });
});

describe('R6-2 SSRF 64:ff9b:1::/48 and IPv4-translated ::ffff:0:0:0/96', () => {
  it.each([
    '64:ff9b:1::a00:1',
    '64:ff9b:1::1',
    '64:ff9b:1:ffff::8.8.8.8',
    '::ffff:0:7f00:1',
    '::ffff:0:127.0.0.1',
    '::ffff:0:a00:1',
  ])('R6-2: refuses %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it('R6-2: IPv4-translated public address (8.8.8.8) is allowed', () => {
    expect(isBlockedIp('::ffff:0:808:808')).toBe(false);
  });
});
