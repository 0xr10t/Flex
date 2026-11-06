// Phase 3 audit (§3.2): outbound hosts (§16.4), SSRF (§8.2 step 3), DNS rebinding, server binding and tokens.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/load.js';
import { createContentFetcher, type HttpResponse } from '../../src/quarantine/fetch.js';
import { isBlockedIp } from '../../src/quarantine/ssrf.js';
import { testConfig } from '../fakes/context.js';
import { Harness, REPORT_TOKEN, UI_TOKEN } from '../acceptance/harness.js';

const ROOT = join(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'src');
function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const files = walk(SRC).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }));

describe('§16.4 outbound network calls (static inventory)', () => {
  it('only these modules open sockets: Ollama, RPC (S0 + ENS), ENS indexer, execution client, URL fetcher', () => {
    const hits = files
      .filter((f) =>
        /\bfetch\(|= fetch\b|from 'node:https?'|from 'node:dns|from 'node:net'|WebSocket|undici/.test(f.text),
      )
      .map((f) => f.path)
      .sort();
    // quarantine/ssrf.ts imports node:net only for BlockList (no sockets).
    expect(hits).toEqual([
      'handoff/execution-client.ts',
      'llm/ollama.ts',
      'quarantine/fetch.ts',
      'quarantine/ssrf.ts',
      'recipients/subnames.ts',
    ]);
  });

  it('every other src file that imports viem uses only pure helpers (no transport / client)', () => {
    const offenders = files
      .filter((f) => /createPublicClient|createWalletClient|createClient|\btransport\b|\bhttp\(/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(offenders).toEqual(['pipeline/s0-balances.ts', 'recipients/ens-client.ts']);
  });

  it('OBS: the Ollama client does not set redirect:"error" (execution client and indexer do); the URL comes from config', () => {
    const o = files.find((f) => f.path === 'llm/ollama.ts')!.text;
    expect(o).not.toMatch(/redirect:/);
    for (const p of ['handoff/execution-client.ts', 'recipients/subnames.ts'])
      expect(files.find((f) => f.path === p)!.text).toMatch(/redirect:\s*'error'/);
    // config validation: only parsability is checked for ollama_url / execution.url, so a non-local Ollama is accepted.
    const cfg = testConfig();
    expect(() => validateConfig({ ...cfg, llm: { ...cfg.llm, ollama_url: 'https://llm.example.com' } })).not.toThrow();
  });
});

describe('SSRF address table (src/quarantine/ssrf.ts)', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'febf::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe',
    'not-an-ip',
    '',
  ];
  it.each(blocked)('blocks %j (spec ranges, v4-mapped, unparsable)', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  const allowed = [
    '93.184.216.34',
    '8.8.8.8',
    '172.15.255.255',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ];
  it.each(allowed)('allows public %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  // OBSERVATIONS (task item 3): ranges the spec does not list. Characterisation, not violations.
  const unlisted: Array<[string, string]> = [
    ['100.64.0.1', 'CGNAT 100.64.0.0/10'],
    ['64:ff9b::7f00:1', 'NAT64 64:ff9b::/96 wrapping 127.0.0.1'],
    ['64:ff9b::a00:1', 'NAT64 wrapping 10.0.0.1'],
    ['2002:7f00:1::1', '6to4 2002::/16 wrapping 127.0.0.1'],
    ['2002:c0a8:101::1', '6to4 wrapping 192.168.1.1'],
    ['::7f00:1', 'IPv4-compatible ::127.0.0.1'],
    ['192.0.0.1', 'IETF protocol 192.0.0.0/24'],
    ['198.18.0.1', 'benchmarking 198.18.0.0/15'],
    ['224.0.0.1', 'multicast 224.0.0.0/4'],
    ['255.255.255.255', 'broadcast'],
    ['ff02::1', 'IPv6 multicast'],
    ['fec0::1', 'IPv6 site-local fec0::/10'],
  ];
  it.each(unlisted)('OBS: %s (%s) is NOT blocked', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe('URL fetcher (§8.2 step 3)', () => {
  const cfg = testConfig();
  const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
  const ok = (type = 'text/plain', body = 'hi', extra: Record<string, string> = {}): HttpResponse => ({
    status: 200,
    headers: { 'content-type': type, ...extra },
    body: (async function* () {
      yield new TextEncoder().encode(body);
    })(),
    destroy: () => undefined,
  });
  const redirect = (to: string): HttpResponse => ({
    status: 302,
    headers: { location: to },
    body: (async function* () {})(),
    destroy: () => undefined,
  });

  it.each([
    'http://example.com/',
    'ftp://example.com/',
    'file:///etc/passwd',
    'https://user:pw@example.com/',
    'https://127.0.0.1/',
    'https://2130706433/', // decimal form, normalised by URL
    'https://0x7f.1/', // hex/short form
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.1.2.3/',
    'https://localhost/',
  ])('refuses %s without opening a connection', async (url) => {
    let gets = 0;
    const f = createContentFetcher(cfg, {
      resolve: async (h) => (h === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : PUBLIC),
      httpGet: async () => (gets++, ok()),
    });
    expect(await f.fetchUrl(url)).toEqual({ ok: false });
    expect(gets).toBe(0);
  });

  it('refuses a hostname when ANY resolved address is private (mixed answer)', async () => {
    let gets = 0;
    const f = createContentFetcher(cfg, {
      resolve: async () => [...PUBLIC, { address: '10.0.0.5', family: 4 }],
      httpGet: async () => (gets++, ok()),
    });
    expect(await f.fetchUrl('https://mixed.example.com/')).toEqual({ ok: false });
    expect(gets).toBe(0);
  });

  it('refuses a redirect to http, to a private host, and past max_redirects; follows a public https redirect', async () => {
    const run = async (hops: string[]): Promise<unknown> => {
      const queue = [...hops];
      const f = createContentFetcher(cfg, {
        resolve: async () => PUBLIC,
        httpGet: async () => {
          const next = queue.shift();
          return next === undefined ? ok() : redirect(next);
        },
      });
      return f.fetchUrl('https://a.example.com/');
    };
    expect(await run(['http://b.example.com/'])).toEqual({ ok: false });
    expect(await run(['https://127.0.0.1/'])).toEqual({ ok: false });
    expect(await run(['https://[::1]/x'])).toEqual({ ok: false });
    expect(await run(Array.from({ length: cfg.fetch.max_redirects + 1 }, () => 'https://c.example.com/'))).toEqual({
      ok: false,
    });
    expect(await run(['https://b.example.com/'])).toEqual({ ok: true, text: 'hi' });
  });

  it('refuses a redirect whose hostname resolves to a private address on the second lookup', async () => {
    const f = createContentFetcher(cfg, {
      resolve: async (h) => (h === 'evil.example.com' ? [{ address: '192.168.0.9', family: 4 }] : PUBLIC),
      httpGet: async () => redirect('https://evil.example.com/'),
    });
    expect(await f.fetchUrl('https://a.example.com/')).toEqual({ ok: false });
  });

  it('caps the body, rejects other content types', async () => {
    const small = { ...cfg, fetch: { ...cfg.fetch, max_bytes: 10 } };
    const big = createContentFetcher(small, {
      resolve: async () => PUBLIC,
      httpGet: async () => ok('text/plain', 'x'.repeat(50)),
    });
    expect(await big.fetchUrl('https://a.example.com/')).toEqual({ ok: false });
    const img = createContentFetcher(cfg, { resolve: async () => PUBLIC, httpGet: async () => ok('image/png') });
    expect(await img.fetchUrl('https://a.example.com/')).toEqual({ ok: false });
  });

  // Task item 4: DNS rebinding. The production HttpGet dials through `pinnedLookup`, which resolves AGAIN at connect
  // time and refuses a private answer. Here the first (pre-check) lookup is public and the second (connect) is
  // private; the request must fail without ever connecting (a connect to 127.0.0.1:443 would give ECONNREFUSED).
  it('DNS rebinding: the address is re-checked at connect time (second lookup private -> refused)', async () => {
    const lookups: string[] = [];
    const f = createContentFetcher(cfg, {
      resolve: async (h) => {
        lookups.push(h);
        return lookups.length === 1 ? PUBLIC : [{ address: '127.0.0.1', family: 4 }];
      },
    });
    expect(await f.fetchUrl('https://rebind.example.com/')).toEqual({ ok: false });
    expect(lookups).toEqual(['rebind.example.com', 'rebind.example.com']); // pre-check + connect-time lookup
  });

  it('DNS rebinding variant: connect-time answer mixes public and private -> refused', async () => {
    let n = 0;
    const f = createContentFetcher(cfg, {
      resolve: async () => (++n === 1 ? PUBLIC : [...PUBLIC, { address: '169.254.169.254', family: 4 }]),
    });
    expect(await f.fetchUrl('https://rebind.example.com/')).toEqual({ ok: false });
    expect(n).toBe(2);
  });
});

describe('server binding and tokens (§14.1, §16.4)', () => {
  it('config accepts only host 127.0.0.1', () => {
    const cfg = testConfig();
    for (const host of ['0.0.0.0', 'localhost', '::1', '::', '192.168.1.5', '']) {
      expect(() => validateConfig({ ...cfg, server: { ...cfg.server, host } }), host).toThrow();
    }
    expect(() => validateConfig(cfg)).not.toThrow();
    expect(JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf8')).server.host).toBe('127.0.0.1');
  });

  it('main() listens on config.server.host only (static) and nothing else calls listen', () => {
    const listens = files.filter((f) => /\.listen\(/.test(f.text));
    expect(listens.map((f) => f.path)).toEqual(['index.ts']);
    expect(listens[0]!.text).toMatch(/app\.listen\(\{ host: config\.server\.host, port: config\.server\.port \}\)/);
  });

  it('a real listen binds 127.0.0.1', async () => {
    const h = new Harness('audit-bind', { calls: [] }, {});
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = h.app.server.address();
    expect(typeof addr === 'object' && addr !== null && addr.address).toBe('127.0.0.1');
    await h.finish();
  });

  const routes: Array<['GET' | 'POST' | 'PUT' | 'DELETE', string, 'ui' | 'report']> = [
    ['POST', '/v1/sessions', 'ui'],
    ['DELETE', '/v1/sessions/ses_000000000000', 'ui'],
    ['POST', '/v1/sessions/ses_000000000000/messages', 'ui'],
    ['POST', '/v1/sessions/ses_000000000000/answers', 'ui'],
    ['POST', '/v1/sessions/ses_000000000000/confirm', 'ui'],
    ['POST', '/v1/sessions/ses_000000000000/cancel', 'ui'],
    ['GET', '/v1/settings/limits', 'ui'],
    ['PUT', '/v1/settings/limits', 'ui'],
    ['GET', '/v1/health', 'ui'],
    ['POST', '/v1/execution/reports', 'report'],
    ['GET', '/v1/unknown', 'ui'],
    ['GET', '/', 'ui'],
  ];
  it.each(routes)(
    '%s %s needs its own bearer token; the other token, none, malformed and prefix are refused',
    async (method, url, which) => {
      const h = new Harness('audit-auth', { calls: [] }, {});
      const good = which === 'ui' ? UI_TOKEN : REPORT_TOKEN;
      const other = which === 'ui' ? REPORT_TOKEN : UI_TOKEN;
      const attempts: Array<Record<string, string>> = [
        {},
        { authorization: `Bearer ${other}` },
        { authorization: good },
        { authorization: `Basic ${good}` },
        { authorization: `bearer ${good}` },
        { authorization: `Bearer ${good.slice(0, -1)}` },
        { authorization: `Bearer ${good}x` },
        { authorization: 'Bearer ' },
      ];
      for (const headers of attempts) {
        const res = await h.app.inject({ method, url, headers, ...(method === 'GET' ? {} : { payload: '{}' }) });
        expect(res.statusCode, JSON.stringify(headers)).toBe(401);
        expect(res.body).not.toContain(good);
      }
      await h.finish();
    },
  );

  it('createApp refuses equal UI and report tokens; loadTokens refuses equal token files', async () => {
    const { createApp } = await import('../../src/server/app.js');
    const h = new Harness('audit-eq', { calls: [] }, {});
    expect(() => createApp({ ...(h as unknown as { app: never }), tokens: { ui: 'x', report: 'x' } } as never)).toThrow(
      /differ/,
    );
    await h.finish();
    const src = files.find((f) => f.path === 'config/tokens.ts')!.text;
    expect(src).toMatch(/ui === report/);
    expect(src).toMatch(/0o600/);
  });

  it('error replies carry status and name only (no echo of request body or error text)', async () => {
    const h = new Harness('audit-err', { calls: [] }, {});
    const bad = await h.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${UI_TOKEN}`, 'content-type': 'application/json' },
      payload: '{"timezone": "send 50 usdc to Aradhya',
    });
    expect(bad.statusCode).toBe(400);
    expect(Object.keys(JSON.parse(bad.body) as object).sort()).toEqual(['error', 'statusCode']);
    expect(bad.body).not.toMatch(/Aradhya|usdc|JSON|Unexpected/i);
    await h.finish();
  });
});
