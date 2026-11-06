// Lane A unit tests: §7 SQLCipher open + pragmas, §5 keychain key, §7.1 migrations, §6.3 DB5 defaults on first run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB5_DEFAULTS } from '../../../src/config/defaults.js';
import {
  DbKeyError,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  getOrCreateDbKey,
  type KeyStore,
} from '../../../src/db/keychain.js';
import { SCHEMA_VERSION, migrate } from '../../../src/db/migrate.js';
import { openDatabase } from '../../../src/db/open.js';
import { createRepos } from '../../../src/db/repos/index.js';
import { TEST_KEY, openTempDb, tempDir } from './helpers.js';

class MemoryKeyStore implements KeyStore {
  value: string | null = null;
  sets = 0;
  get(): string | null {
    return this.value;
  }
  set(v: string): void {
    this.sets++;
    this.value = v;
  }
}

const TABLES = [
  'db1_amount_placeholders',
  'db2_address_book',
  'db3_address_placeholders',
  'db4_balances',
  'db5_limits',
  'db6_spend_log',
  'db7_autopays',
  'db8_history',
  'db8_prompts',
  'db8_sessions',
];

describe('§5 / §7 keychain key', () => {
  it('C-025: service agent-layer, account db-key', () => {
    expect(KEYCHAIN_SERVICE).toBe('agent-layer');
    expect(KEYCHAIN_ACCOUNT).toBe('db-key');
  });

  it('C-025: first run generates 32 random bytes as hex and stores them; later runs reuse them', () => {
    const store = new MemoryKeyStore();
    const k = getOrCreateDbKey(store);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(store.value).toBe(k);
    expect(getOrCreateDbKey(store)).toBe(k);
    expect(store.sets).toBe(1);
    expect(getOrCreateDbKey(new MemoryKeyStore())).not.toBe(k);
  });

  it('C-025: a malformed stored key is rejected, never silently replaced', () => {
    const store = new MemoryKeyStore();
    store.value = 'not-a-key';
    expect(() => getOrCreateDbKey(store)).toThrow(DbKeyError);
    expect(store.sets).toBe(0);
  });
});

describe('§7 SQLCipher open', () => {
  it('C-023: secure_delete, foreign_keys and WAL are on; cipher is sqlcipher', () => {
    const { db } = openTempDb();
    expect(db.pragma('secure_delete', { simple: true })).toBe(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(String(db.pragma('cipher', { simple: true })).toLowerCase()).toBe('sqlcipher');
    db.close();
  });

  it('C-023 / NFR-05: the file on disk is encrypted (no plain SQLite header, no plain-text rows)', () => {
    const { db, path, repos } = openTempDb();
    repos.db8.insertSession({ session_id: 'ses_aaaaaaaaaaaa', timezone: 'Asia/Kolkata', opened_at: 'x' });
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 15).toString('latin1')).not.toBe('SQLite format 3');
    expect(bytes.includes(Buffer.from('Asia/Kolkata'))).toBe(false);
  });

  it('C-023: the DB cannot be read with a different key', () => {
    const { db, path } = openTempDb();
    db.close();
    expect(() => openDatabase(path, 'f'.repeat(64))).toThrow();
    const again = openDatabase(path, TEST_KEY);
    again.close();
  });

  it('C-023: the key must be 64 lowercase hex (it is interpolated into PRAGMA key)', () => {
    const p = join(tempDir(), 'x.db');
    expect(() => openDatabase(p, "abc'; DROP TABLE x; --")).toThrow();
    expect(() => openDatabase(p, 'A'.repeat(64))).toThrow();
  });

  it('C-037: migrations run schema.sql — every §7.1 table exists, user_version set', () => {
    const { db } = openTempDb();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'db%' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toEqual(TABLES);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('C-037: migrate is idempotent (reopening keeps the data, no re-create)', () => {
    const { db, path, repos } = openTempDb();
    repos.db5.insertDefaultsIfMissing('2026-11-05T00:00:00.000Z');
    migrate(db);
    db.close();
    const db2 = openDatabase(path, TEST_KEY);
    expect(createRepos(db2).db5.getAll()).toEqual(DB5_DEFAULTS);
    db2.close();
  });
});

describe('§6.3 DB5 defaults inserted on first run', () => {
  it('C-015…C-022: every §6.3 key is inserted with its default', () => {
    const { repos, db } = openTempDb();
    repos.db5.insertDefaultsIfMissing('2026-11-05T00:00:00.000Z');
    expect(repos.db5.getAll()).toEqual(DB5_DEFAULTS);
    const raw = db.prepare('SELECT key, value FROM db5_limits ORDER BY key').all() as Array<{
      key: string;
      value: string;
    }>;
    // §7.1: DB5 values are JSON text; amounts stay decimal strings inside the JSON.
    expect(Object.fromEntries(raw.map((r) => [r.key, JSON.parse(r.value) as unknown]))).toEqual({
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
    expect(raw.find((r) => r.key === 'per_tx_max')?.value).toBe('{"USDC":"100","ETH":"0.05"}');
  });

  it('C-015…C-022: later runs never overwrite a stored value; only missing keys are added', () => {
    const { repos, db } = openTempDb();
    repos.db5.insertDefaultsIfMissing('t0');
    const changed = { ...DB5_DEFAULTS, autopay_max_weeks: 10 };
    repos.db5.putAll(changed, 't1');
    db.prepare("DELETE FROM db5_limits WHERE key = 'bridge_buffer_pct'").run();
    repos.db5.insertDefaultsIfMissing('t2');
    expect(repos.db5.getAll()).toEqual(changed);
  });

  it('C-031: getAll throws when a key is missing (no silent default)', () => {
    const { repos } = openTempDb();
    expect(() => repos.db5.getAll()).toThrow();
  });
});
