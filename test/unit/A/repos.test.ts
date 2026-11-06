// Lane A unit tests: §7.1 repositories DB1–DB8 against SQLCipher (src/contracts/repos.ts), §7.1 DB2 invariant,
// §7.3 placeholder minting with collision retry, §10.1 pending window, §11.3 V-15 spent today, §7.4 session clearing.
import { describe, expect, it } from 'vitest';
import type { Db6Insert } from '../../../src/contracts/repos.js';
import type { Address, AmountPh, GroupPh } from '../../../src/contracts/types.js';
import { MAX_PLACEHOLDER_DRAWS, PlaceholderCollisionError, nameKey } from '../../../src/db/repos/index.js';
import { DB5_DEFAULTS } from '../../../src/config/defaults.js';
import { openTempDb } from './helpers.js';

const A1 = '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E' as Address;
const A2 = '0x91aB2c3D4e5F60718293a4B5c6D7e8F9012377d0' as Address;
const A3 = '0x1111111111111111111111111111111111111111' as Address;

const db1Row = {
  session_id: 'ses_aaaaaaaaaaaa',
  request_id: 'req_aaaaaaaaaaaa',
  amount: '40',
  token: 'USDC' as const,
  source: 'user' as const,
  origin: 'phrase' as const,
  confirmed: true,
};

function seq(values: string[]): () => string {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] as string;
}

describe('§7.1 DB1 amount placeholders', () => {
  it('C-027 / C-042: mint draws amount_<8 hex>, stores the row with an ISO-8601 UTC created_at', () => {
    const { repos } = openTempDb();
    const ph = repos.db1.mint(db1Row);
    expect(ph).toMatch(/^amount_[0-9a-f]{8}$/);
    expect(repos.db1.get(ph)).toEqual({ ...db1Row, placeholder: ph, created_at: '2026-11-05T10:00:00.000Z' });
  });

  it('C-024: amounts are stored as decimal strings (TEXT), never REAL; a non-string amount is refused', () => {
    const { repos, db } = openTempDb();
    const ph = repos.db1.mint({ ...db1Row, amount: '10.20' });
    expect(db.prepare('SELECT typeof(amount) t, amount FROM db1_amount_placeholders').get()).toEqual({
      t: 'text',
      amount: '10.20',
    });
    expect(repos.db1.get(ph)?.amount).toBe('10.20');
    expect(() => repos.db1.mint({ ...db1Row, amount: 10 as unknown as string })).toThrow();
  });

  it('C-027: listByRequest returns this request rows in insertion order; get of unknown → undefined', () => {
    const { repos } = openTempDb();
    const a = repos.db1.mint(db1Row);
    const b = repos.db1.mint({ ...db1Row, amount: '20' });
    repos.db1.mint({ ...db1Row, request_id: 'req_bbbbbbbbbbbb' });
    expect(repos.db1.listByRequest('req_aaaaaaaaaaaa').map((r) => r.placeholder)).toEqual([a, b]);
    expect(repos.db1.get('amount_00000000' as AmountPh)).toBeUndefined();
  });

  it('C-027: update patches amount/token/source/confirmed; unknown placeholder throws', () => {
    const { repos } = openTempDb();
    const ph = repos.db1.mint({ ...db1Row, source: 'untrusted', origin: 'document', confirmed: false });
    repos.db1.update(ph, { confirmed: true });
    expect(repos.db1.get(ph)?.confirmed).toBe(true);
    repos.db1.update(ph, { amount: '12.5', token: 'ETH', source: 'user' });
    expect(repos.db1.get(ph)).toMatchObject({ amount: '12.5', token: 'ETH', source: 'user', origin: 'document' });
    repos.db1.update(ph, {});
    expect(() => repos.db1.update('amount_00000000' as AmountPh, { confirmed: true })).toThrow();
  });
});

describe('§7.3 placeholder collision retry', () => {
  it('C-043: a primary-key collision draws again', () => {
    const draw = seq(['amount_aaaaaaaa', 'amount_aaaaaaaa', 'amount_aaaaaaaa', 'amount_bbbbbbbb']);
    const { repos } = openTempDb({ newPlaceholder: draw });
    expect(repos.db1.mint(db1Row)).toBe('amount_aaaaaaaa');
    expect(repos.db1.mint(db1Row)).toBe('amount_bbbbbbbb');
  });

  it('C-043: the 5th draw may still succeed (max 5 tries)', () => {
    const { repos } = openTempDb({
      newPlaceholder: seq(['address_aaaaaaaa', ...Array<string>(4).fill('address_aaaaaaaa'), 'address_cccccccc']),
    });
    const row = {
      session_id: 's',
      request_id: 'r',
      kind: 'single' as const,
      name: 'X',
      address: A1,
      ens_name: null,
      chain_id: null,
      group_placeholder: null,
      source: 'user' as const,
    };
    expect(repos.db3.mint(row)).toBe('address_aaaaaaaa');
    expect(repos.db3.mint(row)).toBe('address_cccccccc');
  });

  it('C-043: after 5 colliding draws → internal error (PlaceholderCollisionError), nothing inserted', () => {
    expect(MAX_PLACEHOLDER_DRAWS).toBe(5);
    let draws = 0;
    const { repos } = openTempDb({
      newPlaceholder: () => {
        draws++;
        return 'amount_aaaaaaaa';
      },
    });
    repos.db1.mint(db1Row);
    draws = 0;
    expect(() => repos.db1.mint(db1Row)).toThrow(PlaceholderCollisionError);
    expect(draws).toBe(5);
    expect(repos.db1.listByRequest(db1Row.request_id)).toHaveLength(1);
  });

  it('C-044 / §7.3 rule 5: the same amount twice gets two different placeholders (not derived from the value)', () => {
    const { repos } = openTempDb();
    expect(repos.db1.mint(db1Row)).not.toBe(repos.db1.mint(db1Row));
  });
});

describe('§7.1 DB2 address book', () => {
  it('C-028: addContact inserts one row per chain with the chain display name, name_key, added_by', () => {
    const { repos, db } = openTempDb();
    const r = repos.db2.addContact({ name: '  Aradhya  K ', address: A1, chain_ids: [84532, 421614], ens_name: null });
    expect(r.ok).toBe(true);
    const rows = repos.db2.findByNameKey('aradhya k');
    expect(rows.map((x) => [x.chain_id, x.chain, x.name, x.address, x.added_by])).toEqual([
      [84532, 'Base Sepolia', '  Aradhya  K ', A1, 'user_confirmed'],
      [421614, 'Arbitrum Sepolia', '  Aradhya  K ', A1, 'user_confirmed'],
    ]);
    expect(r.ok && r.rows).toEqual(rows);
    expect(nameKey('  Aradhya  K ')).toBe('aradhya k');
    expect(db.prepare('SELECT count(*) n FROM db2_address_book').get()).toEqual({ n: 2 });
  });

  it('C-028: findByAddress, findByEnsName, listAll', () => {
    const { repos } = openTempDb();
    repos.db2.addContact({ name: 'Riya', address: A1, chain_ids: [84532], ens_name: 'riya.eth' });
    repos.db2.addContact({ name: 'Mihir', address: A2, chain_ids: [11155111], ens_name: null });
    expect(repos.db2.findByAddress(A1).map((r) => r.name)).toEqual(['Riya']);
    expect(repos.db2.findByEnsName('riya.eth').map((r) => r.address)).toEqual([A1]);
    expect(repos.db2.listAll().map((r) => r.name)).toEqual(['Riya', 'Mihir']);
    expect(repos.db2.findByNameKey('nobody')).toEqual([]);
  });

  it('C-035: same name_key with another address → name_taken; nothing inserted', () => {
    const { repos } = openTempDb();
    repos.db2.addContact({ name: 'Mihir', address: A2, chain_ids: [84532], ens_name: null });
    expect(repos.db2.addContact({ name: 'MIHIR', address: A3, chain_ids: [421614], ens_name: null })).toEqual({
      ok: false,
      reason: 'name_taken',
    });
    expect(repos.db2.listAll()).toHaveLength(1);
  });

  it('C-035: same address under another name → address_has_other_name; nothing inserted', () => {
    const { repos } = openTempDb();
    repos.db2.addContact({ name: 'Mihir', address: A2, chain_ids: [84532], ens_name: null });
    expect(repos.db2.addContact({ name: 'Bob', address: A2, chain_ids: [421614], ens_name: null })).toEqual({
      ok: false,
      reason: 'address_has_other_name',
    });
    expect(repos.db2.listAll()).toHaveLength(1);
  });

  it('C-035: same name + same address on a new chain extends the contact; an existing chain is not duplicated', () => {
    const { repos } = openTempDb();
    repos.db2.addContact({ name: 'Mihir', address: A2, chain_ids: [84532], ens_name: null });
    const r = repos.db2.addContact({ name: 'mihir', address: A2, chain_ids: [84532, 421614], ens_name: null });
    expect(r.ok && r.rows.map((x) => x.chain_id)).toEqual([421614]);
    expect(repos.db2.findByNameKey('mihir').map((x) => x.chain_id)).toEqual([84532, 421614]);
  });

  it('C-035: addContact is one transaction — a failure on a later chain rolls back earlier rows', () => {
    const { repos } = openTempDb({
      chainName: (id) => {
        if (id === 421614) throw new Error('boom');
        return 'Base Sepolia';
      },
    });
    expect(() =>
      repos.db2.addContact({ name: 'Mihir', address: A2, chain_ids: [84532, 421614], ens_name: null }),
    ).toThrow('boom');
    expect(repos.db2.listAll()).toEqual([]);
  });

  it('C-035 / §9.4: updateAddressForName moves every row of the name; invariant enforced', () => {
    const { repos } = openTempDb();
    repos.db2.addContact({ name: 'Riya', address: A1, chain_ids: [84532, 421614], ens_name: 'riya.eth' });
    repos.db2.addContact({ name: 'Mihir', address: A2, chain_ids: [84532], ens_name: null });
    expect(repos.db2.updateAddressForName('riya', A2)).toEqual({ ok: false, reason: 'address_has_other_name' });
    const r = repos.db2.updateAddressForName('riya', A3);
    expect(r.ok && r.rows.map((x) => x.address)).toEqual([A3, A3]);
    expect(repos.db2.findByAddress(A1)).toEqual([]);
  });
});

describe('§7.1 DB3 address placeholders', () => {
  const base = {
    session_id: 'ses_aaaaaaaaaaaa',
    request_id: 'req_aaaaaaaaaaaa',
    ens_name: null,
    chain_id: null,
    group_placeholder: null,
    source: 'contact' as const,
  };

  it('C-029 / C-042: single/member → address_<8hex>, group → group_<8hex>; get round-trips', () => {
    const { repos } = openTempDb();
    const single = repos.db3.mint({ ...base, kind: 'single', name: 'Mihir', address: A2, chain_id: 84532 });
    expect(single).toMatch(/^address_[0-9a-f]{8}$/);
    const group = repos.db3.mint({ ...base, kind: 'group', name: 'iitr.eth', address: null, source: 'ens' });
    expect(group).toMatch(/^group_[0-9a-f]{8}$/);
    const m = repos.db3.mint({
      ...base,
      kind: 'member',
      name: 'a.iitr.eth',
      address: A1,
      group_placeholder: group as GroupPh,
      source: 'ens',
    });
    expect(m).toMatch(/^address_[0-9a-f]{8}$/);
    expect(repos.db3.get(single)).toEqual({
      ...base,
      placeholder: single,
      kind: 'single',
      name: 'Mihir',
      address: A2,
      chain_id: 84532,
      reused_from_chain_id: null,
      created_at: '2026-11-05T10:00:00.000Z',
    });
  });

  it('C-029: a single row without a name is refused (§7.1 "NULL never for single")', () => {
    const { repos } = openTempDb();
    expect(() => repos.db3.mint({ ...base, kind: 'single', name: null, address: A1 })).toThrow();
  });

  it('C-029: listMembers returns the members of a group in insertion order', () => {
    const { repos } = openTempDb();
    const g = repos.db3.mint({ ...base, kind: 'group', name: 'iitr.eth', address: null, source: 'ens' }) as GroupPh;
    const other = repos.db3.mint({ ...base, kind: 'group', name: 'x.eth', address: null, source: 'ens' }) as GroupPh;
    const m1 = repos.db3.mint({ ...base, kind: 'member', name: 'b', address: A1, group_placeholder: g, source: 'ens' });
    repos.db3.mint({ ...base, kind: 'member', name: 'z', address: A3, group_placeholder: other, source: 'ens' });
    const m2 = repos.db3.mint({ ...base, kind: 'member', name: 'a', address: A2, group_placeholder: g, source: 'ens' });
    expect(repos.db3.listMembers(g).map((r) => r.placeholder)).toEqual([m1, m2]);
  });

  it('C-029 / §9.5: setReusedFromChain marks the row; unknown placeholder throws', () => {
    const { repos } = openTempDb();
    const p = repos.db3.mint({ ...base, kind: 'single', name: 'Mihir', address: A2, chain_id: 84532 });
    repos.db3.setReusedFromChain(p as `address_${string}`, 421614);
    expect(repos.db3.get(p)?.reused_from_chain_id).toBe(421614);
    expect(() => repos.db3.setReusedFromChain('address_00000000', 84532)).toThrow();
  });
});

describe('§7.1 DB4 balances', () => {
  it('C-030: upsertOk inserts then overwrites with status ok', () => {
    const { repos } = openTempDb();
    repos.db4.upsertOk(
      { chain_id: 84532, chain: 'Base Sepolia', token: 'USDC', balance: '80', base_units: '80000000' },
      't1',
    );
    repos.db4.upsertOk(
      { chain_id: 84532, chain: 'Base Sepolia', token: 'USDC', balance: '70.5', base_units: '70500000' },
      't2',
    );
    expect(repos.db4.get(84532, 'USDC')).toEqual({
      chain_id: 84532,
      chain: 'Base Sepolia',
      token: 'USDC',
      balance: '70.5',
      base_units: '70500000',
      status: 'ok',
      updated_at: 't2',
    });
  });

  it('C-030 / §8.1 step 4: markUnavailable flags both tokens, keeps old values, creates missing rows', () => {
    const { repos } = openTempDb();
    repos.db4.upsertOk(
      { chain_id: 84532, chain: 'Base Sepolia', token: 'USDC', balance: '80', base_units: '80000000' },
      't1',
    );
    repos.db4.markUnavailable(84532, 'Base Sepolia', 't2');
    expect(repos.db4.get(84532, 'USDC')).toMatchObject({ status: 'unavailable', balance: '80', updated_at: 't2' });
    expect(repos.db4.get(84532, 'ETH')).toMatchObject({ status: 'unavailable', balance: '0', base_units: '0' });
    repos.db4.upsertOk(
      { chain_id: 84532, chain: 'Base Sepolia', token: 'USDC', balance: '1', base_units: '1000000' },
      't3',
    );
    expect(repos.db4.get(84532, 'USDC')?.status).toBe('ok');
    expect(repos.db4.listAll().map((r) => `${r.chain_id}/${r.token}`)).toEqual(['84532/ETH', '84532/USDC']);
  });

  it('C-024: balances must be strings', () => {
    const { repos } = openTempDb();
    expect(() =>
      repos.db4.upsertOk(
        { chain_id: 84532, chain: 'B', token: 'ETH', balance: 1 as unknown as string, base_units: '1' },
        't',
      ),
    ).toThrow();
  });
});

describe('§7.1 DB5 limits', () => {
  it('C-031 / C-038: putAll replaces every key; getAll parses them back', () => {
    const { repos } = openTempDb();
    repos.db5.insertDefaultsIfMissing('t0');
    const next = { ...DB5_DEFAULTS, per_tx_max: { USDC: '50', ETH: '0.01' }, allowed_chain_ids: [84532] as const };
    repos.db5.putAll({ ...next, allowed_chain_ids: [84532] }, 't1');
    expect(repos.db5.getAll()).toEqual({ ...next, allowed_chain_ids: [84532] });
  });
});

function db6(over: Partial<Db6Insert>): Db6Insert {
  return {
    request_id: 'req_aaaaaaaaaaaa',
    step: 0,
    kind: 'payment',
    counts_toward_limit: true,
    chain_id: 84532,
    token: 'USDC',
    amount: '10',
    recipient_address: A1,
    intent_id: 'i',
    autopay_id: null,
    status: 'pending',
    tx_hash: null,
    created_at: '2026-11-05T10:00:00.000Z',
    executed_at: null,
    ...over,
  };
}

describe('§7.1 DB6 spend log', () => {
  it('C-032 / C-036: counts_toward_limit must be 1 exactly for payment, bridge_buffer, autopay_payment', () => {
    const { repos } = openTempDb();
    for (const kind of ['payment', 'bridge_buffer', 'autopay_payment'] as const) {
      expect(() => repos.db6.insertMany([db6({ kind, counts_toward_limit: false })])).toThrow();
      repos.db6.insertMany([db6({ kind, counts_toward_limit: true })]);
    }
    for (const kind of ['bridge_out', 'autopay_prefund'] as const) {
      expect(() => repos.db6.insertMany([db6({ kind, counts_toward_limit: true })])).toThrow();
      repos.db6.insertMany([db6({ kind, counts_toward_limit: false })]);
    }
  });

  it('C-032: insertMany is one transaction (a bad row rolls back the batch); amounts must be strings', () => {
    const { repos, db } = openTempDb();
    expect(() => repos.db6.insertMany([db6({}), db6({ kind: 'bridge_out', counts_toward_limit: true })])).toThrow();
    expect(db.prepare('SELECT count(*) n FROM db6_spend_log').get()).toEqual({ n: 0 });
    expect(() => repos.db6.insertMany([db6({ amount: 1 as unknown as string })])).toThrow();
  });

  it('C-032: hasRequest and applyIntentResult (rows of this request and step only)', () => {
    const { repos, db } = openTempDb();
    repos.db6.insertMany([
      db6({ step: 0, kind: 'bridge_out', counts_toward_limit: false, intent_id: 'j' }),
      db6({ step: 0, kind: 'bridge_buffer', counts_toward_limit: true, intent_id: 'j' }),
      db6({ step: 1 }),
    ]);
    expect(repos.db6.hasRequest('req_aaaaaaaaaaaa')).toBe(true);
    expect(repos.db6.hasRequest('req_bbbbbbbbbbbb')).toBe(false);
    const n = repos.db6.applyIntentResult({
      request_id: 'req_aaaaaaaaaaaa',
      step: 0,
      status: 'executed',
      tx_hash: '0xabc',
      executed_at: '2026-11-05T10:05:00Z',
    });
    expect(n).toBe(2);
    expect(db.prepare('SELECT step, status, tx_hash, executed_at FROM db6_spend_log ORDER BY id').all()).toEqual([
      { step: 0, status: 'executed', tx_hash: '0xabc', executed_at: '2026-11-05T10:05:00Z' },
      { step: 0, status: 'executed', tx_hash: '0xabc', executed_at: '2026-11-05T10:05:00Z' },
      { step: 1, status: 'pending', tx_hash: null, executed_at: null },
    ]);
  });

  it('C-032 / §10.1 I-10: pendingRecent = pending, created_at > now−10 min, chain, token, kinds payment/bridge_out/autopay_prefund', () => {
    const { repos } = openTempDb();
    const now = '2026-11-05T10:20:00.000Z';
    repos.db6.insertMany([
      db6({ amount: '1', created_at: '2026-11-05T10:10:01.000Z' }), // 9m59s ago → in
      db6({ amount: '2', created_at: '2026-11-05T10:10:00.000Z' }), // exactly 10 min → out (strict >)
      db6({ amount: '3', created_at: '2026-11-05T10:09:00.000Z' }), // 11 min → out
      db6({ amount: '4', kind: 'bridge_out', counts_toward_limit: false, created_at: '2026-11-05T10:19:00.000Z' }),
      db6({ amount: '5', kind: 'autopay_prefund', counts_toward_limit: false, created_at: '2026-11-05T10:19:00.000Z' }),
      db6({ amount: '6', kind: 'bridge_buffer', created_at: '2026-11-05T10:19:00.000Z' }), // kind not subtracted
      db6({ amount: '7', status: 'executed', executed_at: now, created_at: '2026-11-05T10:19:00.000Z' }),
      db6({ amount: '8', status: 'failed', created_at: '2026-11-05T10:19:00.000Z' }),
      db6({ amount: '9', chain_id: 421614, created_at: '2026-11-05T10:19:00.000Z' }),
      db6({ amount: '10', token: 'ETH', created_at: '2026-11-05T10:19:00.000Z' }),
    ]);
    expect(repos.db6.pendingRecent(84532, 'USDC', now).map((r) => r.amount)).toEqual(['1', '4', '5']);
    expect(repos.db6.pendingRecent(421614, 'USDC', now).map((r) => r.amount)).toEqual(['9']);
    expect(repos.db6.pendingRecent(84532, 'ETH', now).map((r) => r.amount)).toEqual(['10']);
  });

  it('C-032 / V-15 I-38: spentToday counts pending by created_at and executed by executed_at, local date in the session timezone', () => {
    const { repos } = openTempDb();
    // now = 2026-11-06 00:30 in Asia/Kolkata (UTC+5:30) = 2026-11-05T19:00Z.
    const now = '2026-11-05T19:00:00.000Z';
    repos.db6.insertMany([
      db6({ amount: '1', created_at: '2026-11-05T18:29:00.000Z' }), // 23:59 IST on the 5th → yesterday
      db6({ amount: '2', created_at: '2026-11-05T18:31:00.000Z' }), // 00:01 IST on the 6th → today
      db6({
        amount: '3',
        status: 'executed',
        created_at: '2026-11-05T12:00:00.000Z',
        executed_at: '2026-11-05T18:45:00Z',
      }), // executed today
      db6({
        amount: '4',
        status: 'executed',
        created_at: '2026-11-05T18:40:00.000Z',
        executed_at: '2026-11-05T18:20:00Z',
      }), // executed yesterday (local)
      db6({ amount: '5', status: 'failed', created_at: '2026-11-05T18:40:00.000Z' }),
      db6({ amount: '6', kind: 'bridge_out', counts_toward_limit: false, created_at: '2026-11-05T18:40:00.000Z' }),
      db6({ amount: '7', kind: 'bridge_buffer', created_at: '2026-11-05T18:40:00.000Z' }),
      db6({
        amount: '8',
        kind: 'autopay_payment',
        status: 'executed',
        step: null,
        intent_id: null,
        executed_at: '2026-11-05T18:50:00Z',
        created_at: '2026-11-05T18:50:00Z',
      }),
      db6({ amount: '9', token: 'ETH', created_at: '2026-11-05T18:40:00.000Z' }),
    ]);
    expect(repos.db6.spentToday('USDC', 'Asia/Kolkata', now).map((r) => r.amount)).toEqual(['2', '3', '7', '8']);
    expect(repos.db6.spentToday('ETH', 'Asia/Kolkata', now).map((r) => r.amount)).toEqual(['9']);
    // Same rows in UTC: "today" is 2026-11-05 → row 1 and 4 count, and so do 2/3/7/8.
    expect(repos.db6.spentToday('USDC', 'UTC', now).map((r) => r.amount)).toEqual(['1', '2', '3', '4', '7', '8']);
  });
});

describe('§7.1 DB7 autopays', () => {
  const row = {
    autopay_id: 'ap_aaaaaaaaaaaa' as const,
    request_id: 'req_aaaaaaaaaaaa',
    recipient_name: 'Mihir',
    recipient_address: A2,
    chain_id: 84532 as const,
    token: 'USDC' as const,
    amount_per_payment: '10',
    schedule_json: '{"frequency":"weekly"}',
  };

  it('C-033 / I-11: insertPending creates a pending row; get / findByRecipient / listByRequest', () => {
    const { repos } = openTempDb();
    repos.db7.insertPending(row, 't0');
    repos.db7.insertPending({ ...row, autopay_id: 'ap_bbbbbbbbbbbb', request_id: 'req_bbbbbbbbbbbb' }, 't0');
    expect(repos.db7.get('ap_aaaaaaaaaaaa')).toEqual({
      ...row,
      delegate_address: null,
      cre_job_id: null,
      status: 'pending',
      created_at: 't0',
      updated_at: 't0',
    });
    expect(repos.db7.findByRecipient(A2)).toHaveLength(2);
    expect(repos.db7.findByRecipient(A2, 'active')).toEqual([]);
    expect(repos.db7.findByRecipient(A1)).toEqual([]);
    expect(repos.db7.listByRequest('req_bbbbbbbbbbbb').map((r) => r.autopay_id)).toEqual(['ap_bbbbbbbbbbbb']);
    expect(repos.db7.get('ap_000000000000')).toBeUndefined();
  });

  it('C-033: update patches status / delegate / cre_job_id and updated_at; unknown id throws', () => {
    const { repos } = openTempDb();
    repos.db7.insertPending(row, 't0');
    repos.db7.update('ap_aaaaaaaaaaaa', { status: 'active', delegate_address: A1, cre_job_id: 'job1' }, 't1');
    expect(repos.db7.get('ap_aaaaaaaaaaaa')).toMatchObject({
      status: 'active',
      delegate_address: A1,
      cre_job_id: 'job1',
      created_at: 't0',
      updated_at: 't1',
    });
    expect(repos.db7.findByRecipient(A2, 'active')).toHaveLength(1);
    expect(() => repos.db7.update('ap_000000000000', { status: 'ended' }, 't2')).toThrow();
  });
});

describe('§7.1 DB8 session store', () => {
  it('C-034: sessions, prompts and history; recentHistory = last N of this session, most recent first', () => {
    const { repos, db } = openTempDb();
    repos.db8.insertSession({ session_id: 'ses_aaaaaaaaaaaa', timezone: 'Asia/Kolkata', opened_at: 't0' });
    expect(repos.db8.getSession('ses_aaaaaaaaaaaa')).toEqual({
      session_id: 'ses_aaaaaaaaaaaa',
      timezone: 'Asia/Kolkata',
      opened_at: 't0',
    });
    expect(repos.db8.getSession('ses_000000000000')).toBeUndefined();
    repos.db8.insertPrompt({
      session_id: 'ses_aaaaaaaaaaaa',
      request_id: 'r',
      kind: 'typed',
      text: 'hi',
      created_at: 't',
    });
    expect(db.prepare('SELECT kind, text FROM db8_prompts').all()).toEqual([{ kind: 'typed', text: 'hi' }]);
    for (let i = 1; i <= 7; i++) {
      repos.db8.appendHistory({
        session_id: 'ses_aaaaaaaaaaaa',
        request_id: `req_${i}`,
        payments_json: '[]',
        handed_off_at: `t${i}`,
      });
    }
    repos.db8.appendHistory({ session_id: 'ses_other', request_id: 'req_x', payments_json: '[]', handed_off_at: 't9' });
    const h = repos.db8.recentHistory('ses_aaaaaaaaaaaa', 5);
    expect(h.map((r) => r.request_id)).toEqual(['req_7', 'req_6', 'req_5', 'req_4', 'req_3']);
    expect(h[0]).toMatchObject({ session_id: 'ses_aaaaaaaaaaaa', payments_json: '[]', handed_off_at: 't7' });
  });
});

describe('§7.4 session clearing', () => {
  function seedAll(t: ReturnType<typeof openTempDb>): void {
    const { repos } = t;
    repos.db5.insertDefaultsIfMissing('t');
    for (const s of ['ses_aaaaaaaaaaaa', 'ses_bbbbbbbbbbbb']) {
      repos.db8.insertSession({ session_id: s, timezone: 'UTC', opened_at: 't' });
      repos.db8.insertPrompt({
        session_id: s,
        request_id: 'r',
        kind: 'typed',
        text: 'x'.repeat(2000),
        created_at: 't',
      });
      repos.db8.appendHistory({ session_id: s, request_id: 'r', payments_json: '[]', handed_off_at: 't' });
      for (let i = 0; i < 20; i++) repos.db1.mint({ ...db1Row, session_id: s });
      repos.db3.mint({
        session_id: s,
        request_id: 'r',
        kind: 'single',
        name: 'Mihir',
        address: A2,
        ens_name: null,
        chain_id: null,
        group_placeholder: null,
        source: 'contact',
      });
    }
    repos.db2.addContact({ name: 'Mihir', address: A2, chain_ids: [84532], ens_name: null });
    repos.db4.upsertOk(
      { chain_id: 84532, chain: 'Base Sepolia', token: 'USDC', balance: '1', base_units: '1000000' },
      't',
    );
    repos.db6.insertMany([db6({})]);
    repos.db7.insertPending(
      {
        autopay_id: 'ap_aaaaaaaaaaaa',
        request_id: 'r',
        recipient_name: 'Mihir',
        recipient_address: A2,
        chain_id: 84532,
        token: 'USDC',
        amount_per_payment: '1',
        schedule_json: '{}',
      },
      't',
    );
  }

  const count = (t: ReturnType<typeof openTempDb>, table: string): number =>
    (t.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;

  it('C-048 / C-411: every row of DB1, DB3, db8_prompts, db8_history, db8_sessions is deleted (all sessions)', () => {
    const t = openTempDb();
    seedAll(t);
    t.repos.clearSessionStores();
    for (const table of [
      'db1_amount_placeholders',
      'db3_address_placeholders',
      'db8_prompts',
      'db8_history',
      'db8_sessions',
    ]) {
      expect(count(t, table), table).toBe(0);
    }
  });

  it('C-048: DB2, DB4, DB5, DB6, DB7 are untouched', () => {
    const t = openTempDb();
    seedAll(t);
    const before = ['db2_address_book', 'db4_balances', 'db5_limits', 'db6_spend_log', 'db7_autopays'].map((x) =>
      t.db.prepare(`SELECT * FROM ${x}`).all(),
    );
    t.repos.clearSessionStores();
    const after = ['db2_address_book', 'db4_balances', 'db5_limits', 'db6_spend_log', 'db7_autopays'].map((x) =>
      t.db.prepare(`SELECT * FROM ${x}`).all(),
    );
    expect(after).toEqual(before);
    expect(after.every((rows) => rows.length > 0)).toBe(true);
  });

  it('C-408 / §16.4: secure_delete is on and VACUUM runs after the delete (no free pages left)', () => {
    const t = openTempDb();
    seedAll(t);
    const execs: string[] = [];
    const origExec = t.db.exec.bind(t.db);
    t.db.exec = ((sql: string) => {
      execs.push(sql);
      return origExec(sql);
    }) as typeof t.db.exec;
    t.repos.clearSessionStores();
    expect(execs).toEqual(['VACUUM']);
    expect(t.db.pragma('secure_delete', { simple: true })).toBe(1);
    expect(t.db.pragma('freelist_count', { simple: true })).toBe(0);
  });

  it('C-048: the deletes run in one transaction (a failing delete leaves every store as it was)', () => {
    const t = openTempDb();
    seedAll(t);
    // A trigger makes the last statement (db8_sessions) fail: the earlier deletes must roll back.
    t.db.exec("CREATE TRIGGER no_del BEFORE DELETE ON db8_sessions BEGIN SELECT RAISE(ABORT, 'x'); END");
    expect(() => t.repos.clearSessionStores()).toThrow();
    expect(count(t, 'db1_amount_placeholders')).toBe(40);
    expect(count(t, 'db8_prompts')).toBe(2);
  });

  it('§7.1: repos.transaction commits on success and rolls back on throw', () => {
    const { repos } = openTempDb();
    repos.transaction(() => repos.db1.mint(db1Row));
    expect(() =>
      repos.transaction(() => {
        repos.db1.mint(db1Row);
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(repos.db1.listByRequest(db1Row.request_id)).toHaveLength(1);
  });
});
