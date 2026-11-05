// Implements: §7.1 DB5 agent limits (key → JSON value), §6.3 defaults inserted on first run, §7.2 / §16.4
// DB5 written only by PUT /v1/settings/limits (putAll's only caller is the PUT /v1/settings/limits route in src/server/app.ts).
// Owner: Lane A.

import type { Db5Limits } from '../../contracts/repos.js';
import type { LimitKey, Limits } from '../../contracts/types.js';
import { DB5_DEFAULTS, DB5_KEYS } from '../../config/defaults.js';
import type { Database } from '../database.js';

export function createDb5(db: Database): Db5Limits {
  const insertIfMissing = db.prepare('INSERT OR IGNORE INTO db5_limits (key, value, updated_at) VALUES (?, ?, ?)');
  const upsert = db.prepare(
    `INSERT INTO db5_limits (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const all = db.prepare('SELECT key, value FROM db5_limits');

  const insertDefaults = db.transaction((now: string) => {
    for (const key of DB5_KEYS) insertIfMissing.run(key, JSON.stringify(DB5_DEFAULTS[key]), now);
  });
  const putAllTx = db.transaction((limits: Limits, now: string) => {
    for (const key of DB5_KEYS) upsert.run(key, JSON.stringify(limits[key]), now);
  });

  return {
    insertDefaultsIfMissing: (now) => insertDefaults(now),
    getAll() {
      const rows = all.all() as Array<{ key: string; value: string }>;
      const map = new Map(rows.map((r) => [r.key, r.value]));
      const out: Partial<Record<LimitKey, unknown>> = {};
      for (const key of DB5_KEYS) {
        const v = map.get(key);
        if (v === undefined) throw new Error(`db5: missing key ${key}`);
        out[key] = JSON.parse(v) as unknown;
      }
      return out as Limits;
    },
    putAll: (limits, now) => putAllTx(limits, now),
  };
}
