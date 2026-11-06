// Lane A unit tests: §6.1 config loading/validation, §6.1/§16.4 token files, §6.2 static tables, §6.3 DB5 defaults
// constants, §5 stack.
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_CONFIG_PATH,
  chainNames,
  configPath,
  expandHome,
  loadConfig,
  validateConfig,
} from '../../../src/config/load.js';
import { TokenFileError, ensureTokenFile, loadTokens } from '../../../src/config/tokens.js';
import { DB5_DEFAULTS, DB5_KEYS, TOKENS } from '../../../src/config/defaults.js';
import { testConfig } from '../../fakes/context.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-a-config-'));
});
afterEach(() => {
  // temp dirs are left to the OS; nothing secret is written
});

function exampleConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL('../../../config.example.json', import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('§6.1 config path', () => {
  it('C-002: path comes from env AGENT_CONFIG', () => {
    expect(configPath({ AGENT_CONFIG: '/etc/agent/config.json' }, '/home/u')).toBe('/etc/agent/config.json');
  });
  it('C-002: default is ~/.agent-layer/config.json', () => {
    expect(DEFAULT_CONFIG_PATH).toBe('~/.agent-layer/config.json');
    expect(configPath({}, '/home/u')).toBe('/home/u/.agent-layer/config.json');
    expect(configPath({ AGENT_CONFIG: '' }, '/home/u')).toBe('/home/u/.agent-layer/config.json');
  });
  it('§6.1: a leading ~ expands to the home directory', () => {
    expect(expandHome('~/.agent-layer/agent.db', '/h')).toBe('/h/.agent-layer/agent.db');
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('/abs/path', '/h')).toBe('/abs/path');
  });
});

describe('§6.1 config validation', () => {
  it('C-002: the test config (§6.1 shape) validates', () => {
    const cfg = validateConfig(testConfig());
    expect(cfg.server.host).toBe('127.0.0.1');
    expect(chainNames(cfg)).toEqual({ 11155111: 'Sepolia', 84532: 'Base Sepolia', 421614: 'Arbitrum Sepolia' });
  });

  it('C-002: config.example.json has every §6.1 key and passes the schema shape (placeholders aside)', () => {
    const raw = exampleConfig();
    // The example carries "<…>" placeholders for addresses the team fills in; patch only those.
    const patched = structuredClone(raw) as ReturnType<typeof testConfig> & Record<string, unknown>;
    patched.wallet = { address: '0x00000000000000000000000000000000000000Aa' };
    patched.autopay!.fee_collector = '0x00000000000000000000000000000000000000bb';
    patched.ens = {
      ...patched.ens,
      universal_resolver_address: '0x0000000000000000000000000000000000000001',
      indexer_url: 'https://indexer.invalid/graphql',
    };
    patched.chains = patched.chains.map((c) => ({ ...c, rpc_url: c.rpc_url.replace('<anon-rpc>', 'rpc.invalid') }));
    expect(() => validateConfig(patched)).not.toThrow();
    // Without patching, the example's "<anon-rpc>" placeholders are reported by field.
    expect(() => validateConfig({ ...patched, chains: (raw as typeof patched).chains })).toThrow(
      /\/chains\/0\/rpc_url/,
    );
  });

  it('C-002: a missing required key is rejected', () => {
    const c = testConfig() as unknown as Record<string, unknown>;
    delete c.fetch;
    expect(() => validateConfig(c)).toThrow(ConfigError);
  });

  it('C-002: an unknown key is rejected', () => {
    expect(() => validateConfig({ ...testConfig(), extra: 1 })).toThrow(ConfigError);
  });

  it.each(['0', '-1', '0.0000001', '1e2'])('rejects an invalid USDC operator fee %s', (fee) => {
    const c = testConfig();
    c.autopay!.fee.USDC = fee;
    expect(() => validateConfig(c)).toThrow(/\/autopay\/fee\/USDC/);
  });

  it.each(['0', '0.010000000000000001', '0.0000000000000000001'])('rejects an invalid ETH bridge fee cap %s', (fee) => {
    const c = testConfig();
    c.bridge = { ccip_fee_max_eth: fee };
    expect(() => validateConfig(c)).toThrow(/\/bridge\/ccip_fee_max_eth/);
  });

  it('requires an actual fee collector and a payable late window', () => {
    const c = testConfig();
    c.autopay!.fee_collector = '0x0000000000000000000000000000000000000000';
    expect(() => validateConfig(c)).toThrow(/\/autopay\/fee_collector/);
    c.autopay = { ...testConfig().autopay!, late_window_seconds: 59 };
    expect(() => validateConfig(c)).toThrow(/\/autopay\/late_window_seconds/);
  });

  it('C-407 §16.4: server.host other than 127.0.0.1 is rejected', () => {
    const c = testConfig();
    expect(() => validateConfig({ ...c, server: { host: '0.0.0.0', port: 8787 } })).toThrow(ConfigError);
  });

  it('C-002: invalid port, address, timezone, time of day and chain ids are rejected', () => {
    const c = testConfig();
    expect(() => validateConfig({ ...c, server: { host: '127.0.0.1', port: 70000 } })).toThrow(ConfigError);
    expect(() => validateConfig({ ...c, wallet: { address: '0x1234' } })).toThrow(ConfigError);
    expect(() => validateConfig({ ...c, defaults: { timezone: 'Mars/Base', autopay_time_of_day: '10:00' } })).toThrow(
      ConfigError,
    );
    expect(() =>
      validateConfig({ ...c, defaults: { timezone: 'Asia/Kolkata', autopay_time_of_day: '25:00' } }),
    ).toThrow(ConfigError);
    const badChain = structuredClone(c) as unknown as { chains: Array<{ chain_id: number }> };
    (badChain.chains[0] as { chain_id: number }).chain_id = 1;
    expect(() => validateConfig(badChain)).toThrow(ConfigError);
  });

  it('C-002: duplicate chain ids and an ENS chain that is not configured are rejected', () => {
    const c = testConfig();
    expect(() => validateConfig({ ...c, chains: [c.chains[0], c.chains[0]] })).toThrow(ConfigError);
    expect(() => validateConfig({ ...c, chains: [c.chains[1]] })).toThrow(/rpc_chain_id/);
  });

  it('C-002: an unparsable URL is rejected', () => {
    const c = testConfig();
    expect(() => validateConfig({ ...c, execution: { ...c.execution, url: 'not a url' } })).toThrow(ConfigError);
  });

  it('C-002: loadConfig reads and validates a file; missing or non-JSON files fail with ConfigError', () => {
    const p = join(dir, 'config.json');
    writeFileSync(p, JSON.stringify(testConfig()));
    expect(loadConfig(p).chains).toHaveLength(3);
    expect(() => loadConfig(join(dir, 'missing.json'))).toThrow(ConfigError);
    writeFileSync(p, '{not json');
    expect(() => loadConfig(p)).toThrow(ConfigError);
  });

  it('§18: config errors name fields only, never values', () => {
    const c = testConfig();
    try {
      validateConfig({ ...c, wallet: { address: '0xSECRETVALUE' } });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).message).not.toContain('SECRETVALUE');
    }
  });
});

describe('§6.1 / §16.4 token files', () => {
  it('C-003: a missing token file is created with one random 32-byte hex token, mode 0600', () => {
    const p = join(dir, 'sub', 'ui_token');
    const t = ensureTokenFile(p);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(p, 'utf8')).toBe(t);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('C-003: an existing token file is read back (whitespace trimmed), not regenerated', () => {
    const p = join(dir, 'tok');
    const t = ensureTokenFile(p);
    expect(ensureTokenFile(p)).toBe(t);
    writeFileSync(p, `${'ab'.repeat(32)}\n`);
    expect(ensureTokenFile(p)).toBe('ab'.repeat(32));
  });

  it('C-003: a token file that does not hold a 32-byte hex token is rejected', () => {
    const p = join(dir, 'bad');
    writeFileSync(p, 'short');
    expect(() => ensureTokenFile(p)).toThrow(TokenFileError);
  });

  it('C-003: two generated tokens differ (random, not fixed)', () => {
    expect(ensureTokenFile(join(dir, 'a'))).not.toBe(ensureTokenFile(join(dir, 'b')));
  });

  it('C-407 §16.4: loadTokens creates the three token files; UI and report tokens differ', () => {
    const c = testConfig();
    c.auth = { ui_token_file: '~/ui', execution_report_token_file: '~/rep' };
    c.execution = { ...c.execution, outbound_token_file: '~/out' };
    const t = loadTokens(c, dir);
    expect(new Set([t.ui, t.report, t.outbound]).size).toBe(3);
    for (const f of ['ui', 'rep', 'out']) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
  });

  it('C-407 §16.4: identical UI and report tokens are refused', () => {
    const c = testConfig();
    writeFileSync(join(dir, 'same'), 'cd'.repeat(32));
    chmodSync(join(dir, 'same'), 0o600);
    c.auth = { ui_token_file: join(dir, 'same'), execution_report_token_file: join(dir, 'same') };
    c.execution = { ...c.execution, outbound_token_file: join(dir, 'out') };
    expect(() => loadTokens(c)).toThrow(TokenFileError);
    expect(() => loadTokens(c)).toThrow('must be different');
  });

  for (const mode of [0o644, 0o640]) {
    it(`SQ-A-07 / C-407: an existing token file with mode ${mode.toString(8)} is refused, unchanged, and the message has no token`, () => {
      const token = 'ab'.repeat(32);
      const path = join(dir, `tok-${mode.toString(8)}`);
      writeFileSync(path, token);
      chmodSync(path, mode);
      let error: unknown;
      try {
        ensureTokenFile(path);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(TokenFileError);
      expect((error as Error).message).not.toContain(token);
      expect(readFileSync(path, 'utf8')).toBe(token);
      expect(statSync(path).mode & 0o777).toBe(mode);
    });
  }

  it('SQ-A-07: an existing token file with mode 0600 is accepted', () => {
    const token = 'ef'.repeat(32);
    const path = join(dir, 'tok-600');
    writeFileSync(path, `${token}\n`);
    chmodSync(path, 0o600);
    expect(ensureTokenFile(path)).toBe(token);
  });
});

describe('§6.2 static tables / §6.3 defaults', () => {
  it('§6.2: token table — USDC 6 decimals, ETH 18 decimals native', () => {
    expect(TOKENS.USDC.decimals).toBe(6);
    expect(TOKENS.ETH.decimals).toBe(18);
    expect(TOKENS.ETH.native).toBe(true);
  });

  it('C-015…C-022 §6.3: DB5 default values are verbatim', () => {
    expect(DB5_DEFAULTS).toEqual({
      per_tx_max: { USDC: '100', ETH: '0.05' },
      daily_max: { USDC: '300', ETH: '0.15' },
      autopay_max_per_period: { USDC: '100', ETH: '0.05' },
      autopay_max_weeks: 52,
      max_bridges_per_request: 3,
      allowed_chain_ids: [11155111, 84532, 421614],
      eth_gas_reserve: { '11155111': '0.01', '84532': '0.002', '421614': '0.002' },
      bridge_buffer_pct: '0',
      max_group_size: 100,
    });
    expect([...DB5_KEYS].sort()).toEqual(Object.keys(DB5_DEFAULTS).sort());
  });

  it('C-024 / NFR-06: every DB5 default amount is a decimal string, never a number', () => {
    for (const k of ['per_tx_max', 'daily_max', 'autopay_max_per_period'] as const) {
      for (const v of Object.values(DB5_DEFAULTS[k])) expect(typeof v).toBe('string');
    }
    for (const v of Object.values(DB5_DEFAULTS.eth_gas_reserve)) expect(typeof v).toBe('string');
    expect(typeof DB5_DEFAULTS.bridge_buffer_pct).toBe('string');
  });
});

describe('§5 stack', () => {
  it('C-001: package.json pins the §5 stack (fastify, SQLCipher driver, keyring, ajv, luxon, pino, vitest …)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      type: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.type).toBe('module');
    for (const d of [
      'fastify',
      'better-sqlite3-multiple-ciphers',
      '@napi-rs/keyring',
      'ajv',
      'ajv-formats',
      'viem',
      'chrono-node',
      'luxon',
      '@scure/bip39',
      '@scure/base',
      'fastest-levenshtein',
      'pdf-parse',
      'html-to-text',
      'pino',
    ]) {
      expect(pkg.dependencies[d], d).toBeDefined();
    }
    expect(pkg.devDependencies.vitest).toBeDefined();
    expect(pkg.devDependencies.typescript).toMatch(/^5\./);
  });
});
