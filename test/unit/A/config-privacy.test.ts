// Privacy fixes 5, 6 and 10 and anon-rpc over Tor in config: the hand-off stays on 127.0.0.1, chain reads go over https (anon-rpc) or plain http
// only to a node on this machine, the indexer is https or null (group sends off), and `fetch.enabled` switches link reading.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isHttpsOrLoopback, isLoopbackHttp, isTorSocks, validateConfig } from '../../../src/config/load.js';
import type { Config } from '../../../src/contracts/types.js';
import { testConfig } from '../../fakes/context.js';

const withChainUrl = (rpc_url: string): Config => {
  const c = testConfig();
  return { ...c, chains: c.chains.map((x, i) => (i === 1 ? { ...x, rpc_url } : x)) };
};

describe('privacy fix 10: execution.url only on 127.0.0.1 over http', () => {
  it.each([
    'https://exec.example.com',
    'http://exec.example.com:8788',
    'http://0.0.0.0:8788',
    'http://localhost:8788',
    'http://192.168.1.5:8788',
    'https://127.0.0.1:8788',
    'http://user:pw@127.0.0.1:8788',
  ])('rejects %s', (url) => {
    const c = testConfig();
    expect(() => validateConfig({ ...c, execution: { ...c.execution, url } })).toThrow(
      /\/execution\/url must be http:\/\/127\.0\.0\.1/,
    );
  });

  it.each(['http://127.0.0.1:8788', 'http://127.0.0.1:8788/', 'http://127.0.0.1'])('accepts %s', (url) => {
    const c = testConfig();
    expect(validateConfig({ ...c, execution: { ...c.execution, url } }).execution.url).toBe(url);
  });
});

describe('privacy fix 10: chain RPC URLs are https, or plain http only to 127.0.0.1', () => {
  it.each([
    'http://rpc.example.com/sepolia',
    'http://10.0.0.2:8545',
    'http://localhost:8545',
    'http://0.0.0.0:8545',
    'ws://rpc.example.com',
    'wss://rpc.example.com',
    'ftp://rpc.example.com',
  ])('rejects %s, naming the field', (url) => {
    expect(() => validateConfig(withChainUrl(url))).toThrow(
      /\/chains\/1\/rpc_url must be https, or http:\/\/127\.0\.0\.1/,
    );
  });

  it.each(['https://anon-rpc.example/base-sepolia', 'https://127.0.0.1:8545', 'http://127.0.0.1:8545'])(
    'accepts %s',
    (url) => {
      expect(validateConfig(withChainUrl(url)).chains[1]?.rpc_url).toBe(url);
    },
  );

  it('the error names the field, never the URL (§18)', () => {
    try {
      validateConfig(withChainUrl('http://secret-provider.example/v2/KEY123'));
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain('KEY123');
      expect(String(e)).not.toContain('secret-provider');
    }
  });
});

describe('privacy fix 6: ens.indexer_url is https or null', () => {
  it('null is accepted (group sends off)', () => {
    const c = testConfig();
    expect(validateConfig({ ...c, ens: { ...c.ens, indexer_url: null } }).ens.indexer_url).toBeNull();
  });

  it.each(['http://indexer.example/graphql', 'http://127.0.0.1:4000/graphql'])('rejects %s', (indexer_url) => {
    const c = testConfig();
    expect(() => validateConfig({ ...c, ens: { ...c.ens, indexer_url } })).toThrow(/\/ens\/indexer_url must be https/);
  });

  it('rejects an empty string and a non-string', () => {
    const c = testConfig();
    expect(() => validateConfig({ ...c, ens: { ...c.ens, indexer_url: '' } })).toThrow();
    expect(() => validateConfig({ ...c, ens: { ...c.ens, indexer_url: 5 as never } })).toThrow();
  });
});

describe('privacy fix 5: fetch.enabled is required and boolean', () => {
  it('missing or non-boolean is rejected', () => {
    const c = testConfig();
    const { enabled: _enabled, ...rest } = c.fetch;
    expect(() => validateConfig({ ...c, fetch: rest as never })).toThrow();
    expect(() => validateConfig({ ...c, fetch: { ...c.fetch, enabled: 'yes' as never } })).toThrow();
  });
});

describe('the shipped config.example.json is private by default', () => {
  const example = JSON.parse(readFileSync(new URL('../../../config.example.json', import.meta.url), 'utf8')) as Config;

  it("everything leaves through Tor's SOCKS port; RPCs use the anon-rpc placeholder over https", () => {
    expect(example.network.socks_proxy).toBe('socks5h://127.0.0.1:9050');
    for (const c of example.chains) expect(c.rpc_url).toMatch(/^https:\/\/<anon-rpc>\//);
    expect(example.execution.url).toBe('http://127.0.0.1:8788');
  });

  it('with Tor on, link reading and group sends are on (both through Tor), and the indexer is https', () => {
    expect(example.fetch.enabled).toBe(true);
    expect(example.ens.indexer_url).toMatch(/^https:\/\//);
  });
});

describe('anon-rpc over Tor: network.socks_proxy', () => {
  const withProxy = (socks_proxy: unknown): unknown => ({ ...testConfig(), network: { socks_proxy } });

  it.each(['socks5h://127.0.0.1:9050', 'socks5h://127.0.0.1:9150', 'socks5h://127.0.0.1:9050/'])('accepts %s', (p) => {
    expect(validateConfig(withProxy(p)).network.socks_proxy).toBe(p);
  });

  it('accepts null (direct connections)', () => {
    expect(validateConfig(withProxy(null)).network.socks_proxy).toBeNull();
  });

  it.each([
    ['socks5://127.0.0.1:9050', 'resolves DNS here'],
    ['socks4://127.0.0.1:9050', 'no hostnames'],
    ['http://127.0.0.1:9080', 'not SOCKS'],
    ['socks5h://10.0.0.2:9050', 'not this machine'],
    ['socks5h://localhost:9050', 'name, not 127.0.0.1'],
    ['socks5h://127.0.0.1', 'no port'],
    ['socks5h://user:pw@127.0.0.1:9050', 'credentials are set per circuit'],
    ['socks5h://127.0.0.1:9050/x', 'a path'],
    ['not a url', 'unparsable'],
    ['', 'empty'],
  ])('rejects %s (%s)', (p) => {
    expect(() => validateConfig(withProxy(p))).toThrow();
  });

  it('the error names the field', () => {
    expect(() => validateConfig(withProxy('socks5://127.0.0.1:9050'))).toThrow(
      /\/network\/socks_proxy must be socks5h:\/\/127\.0\.0\.1:<port> or null/,
    );
  });

  it('network is required: leaving it out is not "direct"', () => {
    const { network: _n, ...rest } = testConfig();
    expect(() => validateConfig(rest)).toThrow();
  });

  it('isTorSocks', () => {
    expect(isTorSocks('socks5h://127.0.0.1:9050')).toBe(true);
    expect(isTorSocks('socks5://127.0.0.1:9050')).toBe(false);
    expect(isTorSocks('socks5h://127.0.0.1:9050?x=1')).toBe(false);
  });
});

describe('URL helpers', () => {
  it('isLoopbackHttp', () => {
    expect(isLoopbackHttp('http://127.0.0.1:1')).toBe(true);
    expect(isLoopbackHttp('https://127.0.0.1:1')).toBe(false);
    expect(isLoopbackHttp('http://127.0.0.2:1')).toBe(false);
    expect(isLoopbackHttp('http://a@127.0.0.1:1')).toBe(false);
  });
  it('isHttpsOrLoopback', () => {
    expect(isHttpsOrLoopback('https://x.example')).toBe(true);
    expect(isHttpsOrLoopback('http://127.0.0.1:8545')).toBe(true);
    expect(isHttpsOrLoopback('http://x.example')).toBe(false);
  });
});
