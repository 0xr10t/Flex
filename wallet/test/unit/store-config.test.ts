import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approverFor } from '../../src/service.js';
import { loadConfig, parseConfig, readToken } from '../../src/config.js';
import { envelopeHash, openDatabase, Store } from '../../src/store/store.js';
import { ALEX, DB_KEY, envelope, payEth } from '../support/envelopes.js';
import { tempDb } from '../support/temp-db.js';

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'flex-wallet-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('the store', () => {
  it('keeps a request across a restart', () => {
    const path = join(tempDir(), 'wallet.db');
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    const first = openDatabase(path, DB_KEY);
    new Store(first).insertRequest(e, '2026-11-06T10:00:00.000Z');
    first.close();
    const second = openDatabase(path, DB_KEY);
    expect(new Store(second).nextUnfinished()).toEqual(e);
    second.close();
  });

  it('is encrypted: the address is not in the file, and another key cannot open it', () => {
    const path = join(tempDir(), 'wallet.db');
    const db = openDatabase(path, DB_KEY);
    new Store(db).insertRequest(envelope([payEth(0, [[ALEX, '0.01']])]), '2026-11-06T10:00:00.000Z');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    expect(readFileSync(path).toString('latin1')).not.toContain(ALEX);
    expect(() => openDatabase(path, 'cd'.repeat(32))).toThrow();
  });

  it('refuses a badly formed key', () => {
    expect(() => openDatabase(':memory:', `x'; DROP`)).toThrow();
  });

  it('treats key order as the same content', () => {
    expect(envelopeHash({ a: 1, b: { c: 2, d: 3 } })).toBe(envelopeHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(envelopeHash({ a: 1 })).not.toBe(envelopeHash({ a: 2 }));
  });

  it('closes a request only when its last step is finished', () => {
    const store = new Store(tempDb());
    const e = envelope([payEth(0, [[ALEX, '0.01']]), payEth(1, [[ALEX, '0.02']])]);
    store.insertRequest(e, '2026-11-06T10:00:00.000Z');
    store.finishStep(e.request_id, 0, { status: 'failed' }, '2026-11-06T10:00:00.000Z', 0);
    expect(store.nextUnfinished()?.request_id).toBe(e.request_id);
    store.finishStep(e.request_id, 1, { status: 'failed' }, '2026-11-06T10:00:00.000Z', 0);
    expect(store.nextUnfinished()).toBeNull();
  });

  it('stores one report per step, so a repeat finish cannot send two', () => {
    const store = new Store(tempDb());
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    store.insertRequest(e, '2026-11-06T10:00:00.000Z');
    store.finishStep(e.request_id, 0, { status: 'failed' }, '2026-11-06T10:00:00.000Z', 0);
    expect(() => store.finishStep(e.request_id, 0, { status: 'failed' }, '2026-11-06T10:00:00.000Z', 0)).toThrow();
    expect(store.allReports()).toHaveLength(1);
  });
});

describe('the config', () => {
  const valid = {
    server: { host: '127.0.0.1', port: 8788 },
    agent: { url: 'http://127.0.0.1:8787' },
    auth: { inbound_token_file: '/a', report_token_file: '/b' },
    db: { path: '/c' },
    approval: { mode: 'reject_all' },
    network: { socks_proxy: null },
    chains: [{ chain_id: 84532, rpc_url: 'https://rpc.example' }],
  };

  it('accepts the example file once its anon-rpc placeholders are filled in, and refuses it before', () => {
    const path = fileURLToPath(new URL('../../config.example.json', import.meta.url));
    expect(() => loadConfig(path)).toThrow(/rpc_url must be https/);
    const filled = join(tempDir(), 'config.json');
    writeFileSync(filled, readFileSync(path, 'utf8').replaceAll('<anon-rpc>', 'anon-rpc.example'));
    const config = loadConfig(filled);
    expect(config.approval.mode).toBe('reject_all');
    expect(config.chains.every((c) => c.rpc_url.startsWith('https://anon-rpc.example/'))).toBe(true);
  });

  describe('anon-rpc over Tor: network.socks_proxy', () => {
    const withProxy = (socks_proxy: unknown) => ({ ...valid, network: { socks_proxy } });
    it.each(['socks5h://127.0.0.1:9050', 'socks5h://127.0.0.1:9150'])('accepts %s', (p) => {
      expect(parseConfig(withProxy(p)).network.socks_proxy).toBe(p);
    });
    it('accepts null (direct)', () => {
      expect(parseConfig(withProxy(null)).network.socks_proxy).toBeNull();
    });
    it.each([
      'socks5://127.0.0.1:9050',
      'http://127.0.0.1:9080',
      'socks5h://10.0.0.2:9050',
      'socks5h://localhost:9050',
      'socks5h://127.0.0.1',
      'socks5h://u:p@127.0.0.1:9050',
      '',
    ])('refuses %s', (p) => {
      expect(() => parseConfig(withProxy(p))).toThrow();
    });
    it('is required, so a missing one is never read as "direct"', () => {
      const { network: _network, ...rest } = valid;
      expect(() => parseConfig(rest)).toThrow();
    });
    it('the example routes through Tor', () => {
      const path = fileURLToPath(new URL('../../config.example.json', import.meta.url));
      const example = JSON.parse(readFileSync(path, 'utf8')) as { network: { socks_proxy: string } };
      expect(example.network.socks_proxy).toBe('socks5h://127.0.0.1:9050');
    });
  });

  describe('privacy fixes 1 and 10: where the wallet connects', () => {
    const withRpc = (rpc_url: string) => ({ ...valid, chains: [{ chain_id: 84532, rpc_url }] });
    it.each([
      'http://rpc.example/base',
      'http://10.0.0.2:8545',
      'http://localhost:8545',
      'http://127.0.0.1.evil.example:8545',
      'http://user:pw@127.0.0.1:8545',
      'ws://rpc.example',
    ])('refuses rpc_url %s', (url) => {
      expect(() => parseConfig(withRpc(url))).toThrow();
    });
    it.each(['https://anon-rpc.example/base-sepolia', 'http://127.0.0.1:8545', 'https://127.0.0.1:8545'])(
      'accepts rpc_url %s',
      (url) => {
        expect(parseConfig(withRpc(url)).chains[0]?.rpc_url).toBe(url);
      },
    );
    it.each(['http://agent.example:8787', 'https://127.0.0.1:8787', 'http://0.0.0.0:8787', 'http://localhost:8787'])(
      'refuses agent.url %s',
      (url) => {
        expect(() => parseConfig({ ...valid, agent: { url } })).toThrow(/agent\.url must be http:\/\/127\.0\.0\.1/);
      },
    );
    it('the error never repeats the URL (it may hold an API key)', () => {
      try {
        parseConfig(withRpc('http://provider.example/v2/KEY123'));
        expect.unreachable();
      } catch (e) {
        expect(String(e)).not.toContain('KEY123');
      }
    });
  });
  it('refuses a host other than 127.0.0.1 (§16.4)', () => {
    expect(() => parseConfig({ ...valid, server: { host: '0.0.0.0', port: 8788 } })).toThrow();
  });
  it('refuses a mainnet chain', () => {
    expect(() => parseConfig({ ...valid, chains: [{ chain_id: 1, rpc_url: 'https://rpc.example' }] })).toThrow();
  });
  it('refuses a key in the config', () => {
    expect(() => parseConfig({ ...valid, private_key: '0xabc' })).toThrow();
  });
  it('requires the approval mode to be stated', () => {
    const { approval: _approval, ...rest } = valid;
    expect(() => parseConfig(rest)).toThrow();
  });
  it('reads a token and trims the newline', () => {
    const path = join(tempDir(), 'token');
    writeFileSync(path, 'abc\n');
    expect(readToken(path)).toBe('abc');
  });
  it('the default approver signs nothing', async () => {
    const request = { envelope: envelope([payEth(0, [[ALEX, '0.01']])]) } as never;
    expect(await approverFor('reject_all').approve(request)).toBe(false);
    expect(await approverFor('auto_approve_testnets').approve(request)).toBe(true);
  });
});
