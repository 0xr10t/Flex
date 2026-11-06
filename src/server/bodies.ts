// Implements: §14.1 request bodies (sessions, messages with base64 attachments, answers, confirm, cancel) and
// §14.3 execution report body, validated with the shared Ajv instance (§5). Invalid → HTTP 400.
// Owner: Lane A.

import { ajv } from '../schemas/index.js';
import { type MessageInput } from '../contracts/types.js';
import type { AnswerBody } from '../session/manager.js';

const STR = { type: 'string' } as const;

export const validateOpenSession = ajv.compile<{ timezone: string }>({
  type: 'object',
  additionalProperties: false,
  required: ['timezone'],
  properties: { timezone: STR },
});

/** §14.1 messages body. `pasted_blocks`, `attachments`, `urls` may be omitted (treated as empty). */
export const validateMessage = ajv.compile<Partial<MessageInput> & { text: string }>({
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
        properties: { filename: STR, mime: STR, base64: STR },
      },
    },
    urls: { type: 'array', items: STR },
  },
});

/** §14.1 "attachments are base64" (RFC 4648 §4, no line breaks; SQ-A-08). Linear, so safe at 20 MB. */
export const isBase64 = (s: string): boolean => s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);

/** §14.1 answers body: exactly one of chip_id / text / selected_ids. */
export const validateAnswer = ajv.compile<AnswerBody>({
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

export const validateConfirm = ajv.compile<{ request_id: string; decision: 'yes' | 'no' }>({
  type: 'object',
  additionalProperties: false,
  required: ['request_id', 'decision'],
  properties: { request_id: STR, decision: { enum: ['yes', 'no'] } },
});

export const validateCancel = ajv.compile<{ request_id: string }>({
  type: 'object',
  additionalProperties: false,
  required: ['request_id'],
  properties: { request_id: STR },
});

// The wallet and agent validate the same report contract.
export { validateExecutionReport as validateReport } from '@flex/protocol';
