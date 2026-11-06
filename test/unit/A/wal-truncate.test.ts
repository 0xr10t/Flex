// Lane A unit test: O7 / §16.4 / §7.4 — after session close (clearSessionStores) the WAL file is checkpointed and
// truncated so deleted DB1/DB3/DB8 pages do not linger in -wal; DB2, DB4-DB7 are untouched.
import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Address } from '../../../src/contracts/types.js';
import { openTempDb } from './helpers.js';

const A2 = '0x91aB2c3D4e5F60718293a4B5c6D7e8F9012377d0' as Address;

describe('O7 WAL truncated after session close (§16.4, §7.4)', () => {
  it('O7 §16.4: journal_mode is WAL and after clearSessionStores the -wal file is absent or size 0', () => {
    const t = openTempDb();
    expect(String(t.db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    const { repos } = t;
    repos.db5.insertDefaultsIfMissing('t');
    repos.db8.insertSession({ session_id: 'ses_aaaaaaaaaaaa', timezone: 'UTC', opened_at: 't' });
    repos.db8.insertPrompt({
      session_id: 'ses_aaaaaaaaaaaa',
      request_id: 'r',
      kind: 'typed',
      text: 'SECRET-PROMPT '.repeat(200),
      created_at: 't',
    });
    repos.db8.appendHistory({
      session_id: 'ses_aaaaaaaaaaaa',
      request_id: 'r',
      payments_json: '[]',
      handed_off_at: 't',
    });
    for (let i = 0; i < 20; i++)
      repos.db1.mint({
        session_id: 'ses_aaaaaaaaaaaa',
        request_id: 'req_aaaaaaaaaaaa',
        amount: '40',
        token: 'USDC',
        source: 'user',
        origin: 'phrase',
        confirmed: true,
      });
    repos.db3.mint({
      session_id: 'ses_aaaaaaaaaaaa',
      request_id: 'r',
      kind: 'single',
      name: 'Mihir',
      address: A2,
      ens_name: null,
      chain_id: null,
      group_placeholder: null,
      source: 'contact',
    });
    repos.db2.addContact({ name: 'Mihir', address: A2, chain_ids: [84532], ens_name: null });
    repos.db4.upsertOk(
      { chain_id: 84532, chain: 'Base Sepolia', token: 'USDC', balance: '1', base_units: '1000000' },
      't',
    );

    const count = (table: string): number => (t.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
    const kept = ['db2_address_book', 'db4_balances', 'db5_limits', 'db6_spend_log', 'db7_autopays'];
    const before = kept.map((x) => t.db.prepare(`SELECT * FROM ${x}`).all());
    const wal = `${t.path}-wal`;
    expect(existsSync(wal) && statSync(wal).size > 0).toBe(true);

    repos.clearSessionStores();

    for (const table of [
      'db1_amount_placeholders',
      'db3_address_placeholders',
      'db8_prompts',
      'db8_history',
      'db8_sessions',
    ])
      expect(count(table), table).toBe(0);
    expect(kept.map((x) => t.db.prepare(`SELECT * FROM ${x}`).all())).toEqual(before);
    expect(count('db2_address_book')).toBeGreaterThan(0);
    if (existsSync(wal)) expect(statSync(wal).size).toBe(0);
  });
});
