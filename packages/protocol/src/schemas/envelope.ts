// Implements: AGENT_SPEC §12.5 (hand-off envelope v2).
// handoff-envelope.schema.json is the authority for the envelope's shape.

import { readFileSync } from 'node:fs';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

// ajv-formats ships CJS; under NodeNext the default import is the module object.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

export type ChainId = 11155111 | 84532 | 421614;
export type Token = 'USDC' | 'ETH';
export type Hex = `0x${string}`;

/** Exact token quantity: no floating point, rounding, exponent notation or trailing decimal zeroes. */
export interface Amount {
  /** Human-readable decimal string, e.g. "40" USDC. */
  value: string;
  /** Positive integer string equal to value × 10^decimals; checked before approval/signing. */
  base_units: string;
  /** USDC = 6; native ETH = 18. Must agree with the intent's token. */
  decimals: 6 | 18;
}

export interface Payee {
  recipient: Hex;
  amount: Amount;
}

/** One immediate atomic payment, with 1–100 distinct payees on one chain using one asset. */
export interface PaymentI {
  intent_id: 'i';
  step: number;
  /** Earlier bridge steps that must complete before this payment can run. */
  depends_on: number[];
  token: Token;
  /** Registered USDC contract on chain_id, or null for native ETH. */
  token_address: Hex | null;
  chain_id: ChainId;
  recipients: Payee[];
}

/** A CCIP transfer of USDC between the same wallet's accounts. ETH cannot be bridged. */
export interface BridgeJ {
  intent_id: 'j';
  step: number;
  token: 'USDC';
  source_token_address: Hex;
  dest_token_address: Hex;
  source_chain_id: ChainId;
  dest_chain_id: ChainId;
  amount: Amount;
  receiver: 'self';
  /** Source-chain native ETH fee ceiling, separate from the USDC amount; > 0 and ≤ 0.01. */
  fee_max_eth: string;
  /** Later payment/autopay steps funded by this bridge; reciprocal with their depends_on. */
  funds_steps: number[];
}

/** Fixed UTC slots, not a calendar or cron expression. Missed slots are skipped, never accumulated. */
export interface Schedule {
  /** First slot's Unix timestamp in seconds. */
  start_at: number;
  /** Seconds between slots; at least 60. Local clock time can shift at daylight-saving changes. */
  interval_seconds: number;
  /** Number of payable slots, at most 520; interval_seconds × max_runs ≤ 52 weeks. */
  max_runs: number;
  /** Seconds after a slot starts during which it is payable; 60 through interval_seconds. */
  late_window_seconds: number;
  /** Unix seconds; cannot precede the final slot's end, including its late window. */
  end_at: number;
}

/** Register an atomic recurring payment with 1–50 payees. Funds stay in the wallet until execution. */
export interface AutopayK {
  intent_id: 'k';
  step: number;
  depends_on: number[];
  /** Agent registry identifier (ap_<12 hex>); distinct from the on-chain plan_id returned on success. */
  autopay_id: string;
  token: Token;
  token_address: Hex | null;
  chain_id: ChainId;
  /** Amounts paid to each payee on every successful run, excluding the operator fee. */
  recipients: Payee[];
  /** Operator fee per run, in the same token; collector must differ from every payee. */
  fee: { to: Hex; amount: Amount };
  schedule: Schedule;
  /** Caps include all recipients and the fee. Agent emits exact per-run and max_runs totals. */
  limits: { max_per_run: Amount; max_total: Amount };
  executor: 'chainlink-cre';
}

/** Cancel an existing registered plan; no refund transfer or model-supplied delegation is involved. */
export interface CancelL {
  intent_id: 'l';
  step: number;
  autopay_id: string;
  chain_id: ChainId;
  /** 32-byte on-chain plan ID from the wallet's successful k report, not an account address. */
  plan_id: Hex;
}

export type EnvelopeIntent = PaymentI | BridgeJ | AutopayK | CancelL;

/** Canonical agent → wallet wire contract. Both layers validate it with checkEnvelope. */
export interface HandoffEnvelope {
  version: '2';
  /** req_<12 hex>; also the HTTP Idempotency-Key. Retries must reuse the identical envelope. */
  request_id: string;
  /** Account whose funds will be used; the wallet checks it against the connected account. */
  wallet_address: Hex;
  created_at: string;
  /** 1–16 contiguous zero-based steps, with at most 3 bridges. */
  intents: EnvelopeIntent[];
}

export const envelopeSchema = JSON.parse(
  readFileSync(new URL('./handoff-envelope.schema.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile<HandoffEnvelope>(envelopeSchema);

export type EnvelopeResult = { ok: true; envelope: HandoffEnvelope } | { ok: false; paths: string[] };

/** §12.5 schema check. Returns JSON paths only: Ajv's messages and params can repeat values from the input. */
export function validateEnvelope(raw: unknown): EnvelopeResult {
  if (validate(raw)) return { ok: true, envelope: raw };
  const errors: ErrorObject[] = validate.errors ?? [];
  return { ok: false, paths: [...new Set(errors.map((e) => e.instancePath || '/'))] };
}
