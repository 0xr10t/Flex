// Implements: §14.1 PUT /v1/settings/limits validation — full limits object with the §6.3 keys; amounts positive
// decimals; `allowed_chain_ids` ⊆ configured chains, non-empty; `autopay_max_weeks` 1–520;
// `max_bridges_per_request` 0–10; `bridge_buffer_pct` 0–20; invalid → 400 with field errors.
// Interim choices (SQ-A-02): amounts must also fit the token's decimals,
// `eth_gas_reserve` keys must be configured chain ids and cover every allowed chain, chain ids must be unique.
// Owner: Lane A.

import { compareDecimal, fractionDigits, isDecimalString } from '../contracts/money.js';
import { TOKEN_DECIMALS, type Config, type Limits, type Token } from '../contracts/types.js';
import { DB5_KEYS } from '../config/defaults.js';

export interface FieldError {
  field: string;
  message: string;
}

export type LimitsValidation = { ok: true; limits: Limits } | { ok: false; errors: FieldError[] };

const TOKENS: readonly Token[] = ['USDC', 'ETH'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Positive decimal string within `decimals` fractional digits. */
function positiveAmount(v: unknown, decimals: number): string | null {
  if (typeof v !== 'string' || !isDecimalString(v)) return 'must be a decimal string';
  if (fractionDigits(v) > decimals) return `must have at most ${decimals} decimal places`;
  if (compareDecimal(v, '0', decimals) <= 0) return 'must be greater than 0';
  return null;
}

function intInRange(v: unknown, min: number, max: number): string | null {
  if (typeof v !== 'number' || !Number.isInteger(v)) return 'must be an integer';
  if (v < min || v > max) return `must be between ${min} and ${max}`;
  return null;
}

export function validateLimits(body: unknown, config: Config): LimitsValidation {
  const errors: FieldError[] = [];
  const err = (field: string, message: string | null): void => {
    if (message !== null) errors.push({ field, message });
  };
  if (!isObj(body)) return { ok: false, errors: [{ field: '', message: 'must be an object' }] };

  for (const key of Object.keys(body)) {
    if (!(DB5_KEYS as readonly string[]).includes(key)) err(key, 'unknown key');
  }
  for (const key of DB5_KEYS) if (!(key in body)) err(key, 'is required');

  for (const key of ['per_tx_max', 'daily_max', 'autopay_max_per_period'] as const) {
    if (!(key in body)) continue;
    const v = body[key];
    if (!isObj(v)) {
      err(key, 'must be an object with USDC and ETH');
      continue;
    }
    for (const k of Object.keys(v)) if (!TOKENS.includes(k as Token)) err(`${key}.${k}`, 'unknown token');
    for (const t of TOKENS) {
      if (!(t in v)) err(`${key}.${t}`, 'is required');
      else err(`${key}.${t}`, positiveAmount(v[t], TOKEN_DECIMALS[t]));
    }
  }

  if ('autopay_max_weeks' in body) err('autopay_max_weeks', intInRange(body.autopay_max_weeks, 1, 520));
  if ('max_bridges_per_request' in body) {
    err('max_bridges_per_request', intInRange(body.max_bridges_per_request, 0, 10));
  }

  const configured = config.chains.map((c) => c.chain_id as number);
  let allowed: number[] = [];
  if ('allowed_chain_ids' in body) {
    const v = body.allowed_chain_ids;
    if (!Array.isArray(v) || v.length === 0) {
      err('allowed_chain_ids', 'must be a non-empty array');
    } else if (!v.every((x) => typeof x === 'number' && configured.includes(x))) {
      err('allowed_chain_ids', 'must contain only configured chain ids');
    } else if (new Set(v).size !== v.length) {
      err('allowed_chain_ids', 'must not repeat a chain id');
    } else {
      allowed = v as number[];
    }
  }

  if ('eth_gas_reserve' in body) {
    const v = body.eth_gas_reserve;
    if (!isObj(v)) {
      err('eth_gas_reserve', 'must be an object keyed by chain id');
    } else {
      for (const [k, amount] of Object.entries(v)) {
        if (!configured.some((c) => String(c) === k)) err(`eth_gas_reserve.${k}`, 'unknown chain id');
        else err(`eth_gas_reserve.${k}`, positiveAmount(amount, TOKEN_DECIMALS.ETH));
      }
      for (const c of allowed) if (!(String(c) in v)) err(`eth_gas_reserve.${c}`, 'is required for an allowed chain');
    }
  }

  if ('bridge_buffer_pct' in body) {
    const v = body.bridge_buffer_pct;
    if (typeof v !== 'string' || !isDecimalString(v)) err('bridge_buffer_pct', 'must be a decimal string');
    else if (compareDecimal(v, '20', fractionDigits(v)) > 0) {
      err('bridge_buffer_pct', 'must be between 0 and 20');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  // Every key was checked above and unknown keys were refused, so the body is exactly a Limits object.
  return { ok: true, limits: body as unknown as Limits };
}
