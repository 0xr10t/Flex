// Implements: §7.1 DB2 address book (persistent) and its invariant (same name_key ⇒ same address; same address ⇒
// same name_key) enforced in one transaction, §9.1 step 1 name_key normalisation, §9.2 step 7 / §9.3 step 7
// add_contact (the only DB2 insert path, added_by='user_confirmed'), §9.4 "Use new address" update.
// Owner: Lane A.

import type { AddContactResult, Db2AddressBook, Db2Row } from '../../contracts/repos.js';
import type { Address, ChainId } from '../../contracts/types.js';
import { nameKey } from '../../lexical/text.js';
import type { Database } from '../database.js';
import type { RepoOptions } from './common.js';

interface Raw {
  id: number;
  name: string;
  name_key: string;
  chain_id: number;
  chain: string;
  address: string;
  ens_name: string | null;
  added_at: string;
  added_by: string;
}

const fromRaw = (r: Raw): Db2Row => ({
  id: r.id,
  name: r.name,
  name_key: r.name_key,
  chain_id: r.chain_id as ChainId,
  chain: r.chain,
  address: r.address as Address,
  ens_name: r.ens_name,
  added_at: r.added_at,
  added_by: 'user_confirmed',
});

export function createDb2(db: Database, opts: RepoOptions): Db2AddressBook {
  const byNameKey = db.prepare('SELECT * FROM db2_address_book WHERE name_key = ? ORDER BY id');
  const byAddress = db.prepare('SELECT * FROM db2_address_book WHERE address = ? ORDER BY id');
  const byEns = db.prepare('SELECT * FROM db2_address_book WHERE ens_name = ? ORDER BY id');
  const all = db.prepare('SELECT * FROM db2_address_book ORDER BY id');
  const byId = db.prepare('SELECT * FROM db2_address_book WHERE id = ?');
  const exists = db.prepare('SELECT 1 FROM db2_address_book WHERE name_key = ? AND chain_id = ?');
  const insert = db.prepare(
    `INSERT INTO db2_address_book (name, name_key, chain_id, chain, address, ens_name, added_at, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'user_confirmed')`,
  );
  const otherNameForAddress = db.prepare('SELECT 1 FROM db2_address_book WHERE address = ? AND name_key <> ? LIMIT 1');
  const otherAddressForName = db.prepare('SELECT 1 FROM db2_address_book WHERE name_key = ? AND address <> ? LIMIT 1');
  const updateAddr = db.prepare('UPDATE db2_address_book SET address = ? WHERE name_key = ?');

  /** §7.1 invariant check for adding (name_key, address). */
  const invariantViolation = (key: string, address: Address): AddContactResult | null => {
    if (otherAddressForName.get(key, address) !== undefined) return { ok: false, reason: 'name_taken' };
    if (otherNameForAddress.get(address, key) !== undefined) return { ok: false, reason: 'address_has_other_name' };
    return null;
  };

  const addContactTx = db.transaction(
    (args: { name: string; address: Address; chain_ids: ChainId[]; ens_name: string | null }): AddContactResult => {
      const key = nameKey(args.name);
      const bad = invariantViolation(key, args.address);
      if (bad) return bad;
      const rows: Db2Row[] = [];
      const added_at = opts.now();
      for (const chain_id of args.chain_ids) {
        if (exists.get(key, chain_id) !== undefined) continue;
        const res = insert.run(
          args.name,
          key,
          chain_id,
          opts.chainName(chain_id),
          args.address,
          args.ens_name,
          added_at,
        );
        rows.push(fromRaw(byId.get(res.lastInsertRowid) as Raw));
      }
      return { ok: true, rows };
    },
  );

  const updateTx = db.transaction((key: string, address: Address): AddContactResult => {
    if (otherNameForAddress.get(address, key) !== undefined) return { ok: false, reason: 'address_has_other_name' };
    updateAddr.run(address, key);
    return { ok: true, rows: (byNameKey.all(key) as Raw[]).map(fromRaw) };
  });

  return {
    findByNameKey: (k) => (byNameKey.all(k) as Raw[]).map(fromRaw),
    findByAddress: (a) => (byAddress.all(a) as Raw[]).map(fromRaw),
    findByEnsName: (e) => (byEns.all(e) as Raw[]).map(fromRaw),
    listAll: () => (all.all() as Raw[]).map(fromRaw),
    addContact: (args) => addContactTx(args),
    updateAddressForName: (k, address) => updateTx(k, address),
  };
}
