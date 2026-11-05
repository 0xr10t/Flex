// Implements: §14.1 request bodies (sessions, messages with base64 attachments, answers, confirm, cancel) and
// §14.3 execution report body, validated with the shared Ajv instance (§5). Invalid → HTTP 400.
// Owner: Lane A.

import { ajv } from '../schemas/index.js';
import { CHAIN_IDS } from '../contracts/types.js';

const STR = { type: 'string' } as const;

export const validateOpenSession = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['timezone'],
  properties: { timezone: STR },
});

/** §14.1 messages body. `pasted_blocks`, `attachments`, `urls` may be omitted (treated as empty). */
export const validateMessage = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: STR,
    pasted_blocks: { type: 'array', items: STR },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['filename', 'mime', 'base64'],
        properties: { filename: STR, mime: STR, base64: { type: 'string', pattern: '^[A-Za-z0-9+/=\\s]*$' } },
      },
    },
    urls: { type: 'array', items: STR },
  },
});

/** §14.1 answers body: exactly one of chip_id / text / selected_ids. */
export const validateAnswer = ajv.compile({
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['question_id', 'chip_id'],
      properties: { question_id: STR, chip_id: STR },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['question_id', 'text'],
      properties: { question_id: STR, text: STR },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['question_id', 'selected_ids'],
      properties: { question_id: STR, selected_ids: { type: 'array', items: STR } },
    },
  ],
});

export const validateConfirm = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['request_id', 'decision'],
  properties: { request_id: STR, decision: { enum: ['yes', 'no'] } },
});

export const validateCancel = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['request_id'],
  properties: { request_id: STR },
});

const DECIMAL = { type: 'string', pattern: '^\\d+(\\.\\d+)?$' } as const;
const ADDRESS = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } as const;
const TX_HASH = { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' } as const;
const DATE_TIME = { type: 'string', format: 'date-time' } as const;
const ID = { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,128}$' } as const;

/** §14.3 report body (shape check; per-kind required fields are checked in the route). */
export const validateReport = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { enum: ['intent_result', 'autopay_payment', 'autopay_status'] },
    request_id: ID,
    step: { type: 'integer', minimum: 0 },
    status: { enum: ['executed', 'failed'] },
    tx_hash: TX_HASH,
    executed_at: DATE_TIME,
    autopay: {
      type: 'object',
      additionalProperties: false,
      required: ['autopay_id'],
      properties: {
        autopay_id: ID,
        delegate_address: ADDRESS,
        cre_job_id: ID,
        status: { enum: ['active', 'cancelled', 'ended', 'failed'] },
        amount: DECIMAL,
        chain_id: { enum: [...CHAIN_IDS] },
        token: { enum: ['USDC', 'ETH'] },
      },
    },
  },
});
