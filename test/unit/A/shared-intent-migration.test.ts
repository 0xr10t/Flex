import BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db6Insert } from '../../../src/contracts/repos.js';
import { migrate, SCHEMA_VERSION } from '../../../src/db/migrate.js';
import { openDatabase } from '../../../src/db/open.js';
import { createRepos } from '../../../src/db/repos/index.js';
import { TEST_KEY, tempDir } from './helpers.js';

const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const NOW = '2026-11-05T10:00:00.000Z';

function legacyDatabase(path: string) {
  const db = new BetterSqlite3(path);
  db.pragma("cipher = 'sqlcipher'");
  db.pragma(`key = '${TEST_KEY}'`);
  db.exec(readFileSync(new URL('../../../src/db/schema.sql', import.meta.url), 'utf8'));
  db.exec(`CREATE TABLE handoff_journal (
    request_id TEXT PRIMARY KEY, envelope_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('submitted','accepted','rejected')), history_json TEXT
  )`);
  db.pragma('user_version = 2');
  db.prepare(
    `INSERT INTO db6_spend_log
    (id,request_id,step,kind,counts_toward_limit,chain_id,token,amount,status,created_at)
    VALUES (27,'req_000000000001',0,'autopay_prefund',0,84532,'USDC','100','executed',?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO db7_autopays
    (autopay_id,request_id,recipient_name,recipient_address,chain_id,token,amount_per_payment,
     schedule_json,delegate_address,cre_job_id,status,created_at,updated_at)
    VALUES ('ap_000000000001','req_000000000001','A',?,84532,'USDC','10','{}',?,'old-job','active',?,?)`,
  ).run(A, B, NOW, NOW);
  db.prepare('INSERT INTO handoff_journal VALUES (?,?,?,?)').run(
    'req_000000000001',
    '{"version":"1"}',
    'accepted',
    null,
  );
  return db;
}

describe('shared v2 intent persistence', () => {
  it('migrates an encrypted v2 DB without rewriting historical prefunds, delegation metadata or handoffs', () => {
    const dir = tempDir('flex-migration-');
    const path = join(dir, 'agent.db');
    const old = legacyDatabase(path);
    const spend = old.prepare('SELECT * FROM db6_spend_log').get();
    const autopay = old.prepare('SELECT * FROM db7_autopays').get();
    old.close();
    try {
      for (let reopen = 0; reopen < 2; reopen++) {
        const db = openDatabase(path, TEST_KEY);
        try {
          expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
          expect(db.prepare('SELECT * FROM db6_spend_log').get()).toEqual({ ...(spend as object), autopay_slot: null });
          expect(db.prepare('SELECT * FROM db7_autopays').get()).toEqual({
            ...(autopay as object),
            plan_id: null,
            executor_address: null,
            fee: null,
            recipients_json: null,
            display_json: null,
          });
          expect(db.prepare('SELECT envelope_json FROM handoff_journal').get()).toEqual({
            envelope_json: '{"version":"1"}',
          });
        } finally {
          db.close();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back every schema and data change when a later migration statement fails', () => {
    const dir = tempDir('flex-migration-rollback-');
    const db = legacyDatabase(join(dir, 'agent.db'));
    try {
      // Force the last CREATE INDEX to fail, after the table replacement and new DB7 columns.
      db.exec('CREATE TABLE db6_autopay_run (conflict TEXT)');
      expect(() => migrate(db)).toThrow();
      expect(db.pragma('user_version', { simple: true })).toBe(2);
      expect(db.prepare('SELECT id,kind FROM db6_spend_log').all()).toEqual([{ id: 27, kind: 'autopay_prefund' }]);
      expect((db.pragma('table_info(db7_autopays)') as Array<{ name: string }>).map((c) => c.name)).not.toContain(
        'plan_id',
      );
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='db6_spend_log_v1'").get()).toBeUndefined();
      db.exec('DROP TABLE db6_autopay_run');
      expect(() => migrate(db)).not.toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deduplicates by plan, slot and spend kind, while allowing several plans in one transaction', () => {
    const dir = tempDir('flex-slot-dedupe-');
    const db = openDatabase(join(dir, 'agent.db'), TEST_KEY);
    const repos = createRepos(db);
    const row: Db6Insert = {
      request_id: 'req_000000000001',
      step: null,
      kind: 'autopay_payment',
      counts_toward_limit: true,
      chain_id: 84532,
      token: 'USDC',
      amount: '10',
      recipient_address: A,
      intent_id: 'k',
      autopay_id: 'ap_000000000001',
      autopay_slot: 0,
      status: 'executed',
      tx_hash: `0x${'ab'.repeat(32)}`,
      created_at: NOW,
      executed_at: NOW,
    };
    try {
      repos.db6.insertMany([
        row,
        { ...row, kind: 'autopay_fee', amount: '0.05' },
        { ...row, autopay_id: 'ap_000000000002' },
      ]);
      expect(repos.db6.listByRequest(row.request_id)).toHaveLength(3);
      expect(() => repos.db6.insertMany([{ ...row, autopay_slot: 1 }, row])).toThrow(/UNIQUE/);
      expect(repos.db6.listByRequest(row.request_id)).toHaveLength(3);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds a multi-recipient plan by any payee, including checksum variants and legacy primary recipients', () => {
    const dir = tempDir('flex-recipient-lookup-');
    const db = openDatabase(join(dir, 'agent.db'), TEST_KEY);
    const repos = createRepos(db);
    try {
      repos.db7.insertPending(
        {
          autopay_id: 'ap_000000000001',
          request_id: 'req_000000000001',
          recipient_name: 'A',
          recipient_address: A,
          chain_id: 84532,
          token: 'USDC',
          amount_per_payment: '20',
          schedule_json: '{}',
          recipients_json: JSON.stringify([{ recipient: A }, { recipient: B }]),
        },
        NOW,
      );
      repos.db7.update('ap_000000000001', { status: 'active' }, NOW);
      expect(repos.db7.findByRecipient(B, 'active').map((r) => r.autopay_id)).toEqual(['ap_000000000001']);
      expect(repos.db7.findByRecipient('0x00000000000000000000000000000000000000BB')).toHaveLength(1);
      expect(repos.db7.findByRecipient(A, 'active')).toHaveLength(1);
      expect(repos.db7.findByRecipient(B, 'cancelled')).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
