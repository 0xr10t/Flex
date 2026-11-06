/** Wallet → agent reports. IDs refer to the confirmed envelope, never to model output. */
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ChainId, Hex, Token } from './envelope.js';

export interface AutopayIdentity {
  autopay_id: string;
  /** Registered on-chain intent hash, used by cancellation and run deduplication. */
  plan_id: Hex;
  executor_address: Hex;
  chain_id: ChainId;
  token: Token;
}

export interface IntentResultReport {
  kind: 'intent_result';
  request_id: string;
  step: number;
  status: 'executed' | 'failed';
  /** Absent when an already-cancelled plan needs no new transaction. */
  tx_hash?: Hex;
  executed_at?: string;
  /** k success carries the complete identity; k/l failures and l success carry autopay_id. */
  autopay?: Pick<AutopayIdentity, 'autopay_id'> & Partial<Omit<AutopayIdentity, 'autopay_id'>>;
  /** Actual ETH bridge fee, replacing the submitted maximum in the spend log. */
  bridge_fee_eth?: string;
}

export interface AutopayPaymentReport {
  kind: 'autopay_payment';
  request_id: string;
  status: 'executed';
  tx_hash: Hex;
  executed_at: string;
  autopay: AutopayIdentity & {
    /** Zero-based scheduled slot. A retry of the same plan and slot counts once. */
    slot: number;
    status: 'active';
    /** Sum paid to recipients, excluding the operator fee. Both are token decimal strings. */
    amount: string;
    fee: string;
  };
}

export interface AutopayStatusReport {
  kind: 'autopay_status';
  request_id: string;
  autopay: AutopayIdentity & { status: 'ended' | 'cancelled' | 'failed' };
}

export type ExecutionReport = IntentResultReport | AutopayPaymentReport | AutopayStatusReport;

const address = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' };
const hash = { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' };
const decimal = { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]*[1-9])?$' };
const time = { type: 'string', format: 'date-time' };
const request = { type: 'string', pattern: '^req_[0-9a-f]{12}$' };
const identity = {
  autopay_id: { type: 'string', pattern: '^ap_[0-9a-f]{12}$' },
  plan_id: hash,
  executor_address: address,
  chain_id: { enum: [11155111, 84532, 421614] },
  token: { enum: ['USDC', 'ETH'] },
};
const object = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

export const executionReportSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'flex/execution-report/v2',
  oneOf: [
    {
      ...object(
        {
          kind: { const: 'intent_result' },
          request_id: request,
          step: { type: 'integer', minimum: 0, maximum: 15 },
          status: { enum: ['executed', 'failed'] },
          tx_hash: hash,
          executed_at: time,
          autopay: object(identity, ['autopay_id']),
          bridge_fee_eth: decimal,
        },
        ['kind', 'request_id', 'step', 'status'],
      ),
      allOf: [
        {
          if: { properties: { status: { const: 'executed' } } },
          then: { properties: { executed_at: time }, required: ['executed_at'] },
        },
      ],
    },
    object({
      kind: { const: 'autopay_payment' },
      request_id: request,
      status: { const: 'executed' },
      tx_hash: hash,
      executed_at: time,
      autopay: object({
        ...identity,
        slot: { type: 'integer', minimum: 0, maximum: 519 },
        status: { const: 'active' },
        amount: decimal,
        fee: decimal,
      }),
    }),
    object({
      kind: { const: 'autopay_status' },
      request_id: request,
      autopay: object({ ...identity, status: { enum: ['ended', 'cancelled', 'failed'] } }),
    }),
  ],
};

const ajv = new Ajv2020({ strict: true, allErrors: true });
(addFormatsModule as unknown as (instance: Ajv2020) => Ajv2020)(ajv);
export const validateExecutionReport = ajv.compile<ExecutionReport>(executionReportSchema);
