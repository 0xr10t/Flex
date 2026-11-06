// Implements: §6.3 DB5 defaults (inserted on first run), §6.2 static tables (consumed from
// src/contracts/static-tables.ts, re-exported here so src/config/ is the one place config-time tables live, §21).
// Owner: Lane A.

import type { LimitKey, Limits } from '../contracts/types.js';

export * from '../contracts/static-tables.js';

/** §6.3 defaults, verbatim. `autopay_max_per_period` = `per_tx_max` (D-26). */
export const DB5_DEFAULTS: Readonly<Limits> = Object.freeze<Limits>({
  per_tx_max: { USDC: '100', ETH: '0.05' },
  daily_max: { USDC: '300', ETH: '0.15' },
  autopay_max_per_period: { USDC: '100', ETH: '0.05' },
  autopay_max_weeks: 52,
  max_bridges_per_request: 3,
  allowed_chain_ids: [11155111, 84532, 421614],
  eth_gas_reserve: { '11155111': '0.01', '84532': '0.002', '421614': '0.002' },
  bridge_buffer_pct: '2',
});

/** The eight DB5 keys of §6.3, in table order. */
export const DB5_KEYS: readonly LimitKey[] = [
  'per_tx_max',
  'daily_max',
  'autopay_max_per_period',
  'autopay_max_weeks',
  'max_bridges_per_request',
  'allowed_chain_ids',
  'eth_gas_reserve',
  'bridge_buffer_pct',
];
