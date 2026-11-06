// Implements: AGENT_SPEC §12.5 (hand-off envelope v2), as changed by docs/wallet/ARCHITECTURE_CHANGES.md.
// handoff-envelope.schema.json is the authority for the envelope's shape.

import { readFileSync } from 'node:fs';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

// ajv-formats ships CJS; under NodeNext the default import is the module object.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

export type ChainId = 11155111 | 84532 | 421614;
export type Token = 'USDC' | 'ETH';
export type Hex = `0x${string}`;

export interface Amount {
  value: string;
  base_units: string;
  decimals: 6 | 18;
}

export interface Payee {
  recipient: Hex;
  amount: Amount;
}

export interface PaymentI {
  intent_id: 'i';
  step: number;
  depends_on: number[];
  token: Token;
  token_address: Hex | null;
  chain_id: ChainId;
  recipients: Payee[];
}

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
  fee_max_eth: string;
  funds_steps: number[];
}

export interface Schedule {
  start_at: number;
  interval_seconds: number;
  max_runs: number;
  late_window_seconds: number;
  end_at: number;
}

export interface AutopayK {
  intent_id: 'k';
  step: number;
  depends_on: number[];
  autopay_id: string;
  token: Token;
  token_address: Hex | null;
  chain_id: ChainId;
  recipients: Payee[];
  fee: { to: Hex; amount: Amount };
  schedule: Schedule;
  limits: { max_per_run: Amount; max_total: Amount };
  executor: 'chainlink-cre';
}

export interface CancelL {
  intent_id: 'l';
  step: number;
  autopay_id: string;
  chain_id: ChainId;
  plan_id: Hex;
}

export type EnvelopeIntent = PaymentI | BridgeJ | AutopayK | CancelL;

export interface HandoffEnvelope {
  version: '2';
  request_id: string;
  wallet_address: Hex;
  created_at: string;
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
