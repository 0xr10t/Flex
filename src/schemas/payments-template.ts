// Implements: §12.2 S8 per-request schema (template), filled slot by slot.
// Owned by the Orchestrator. Lane D computes the slot values (enums, maxItems formula §8.9) and calls this.

import type { ActionKind, AddressPh, AmountPh, ChainId, GroupPh } from '../contracts/types.js';

export interface PaymentsSchemaSlots {
  /** «N»: maxItems = min(50, A × R + R) — computed by Lane D (§8.9). */
  maxItems: number;
  /** «actions»: the S4 actions, e.g. ["i","k"]. */
  kinds: ActionKind[];
  /** «amount enum» without the trailing null; null is appended here. */
  amounts: AmountPh[];
  /** «recipient enum». */
  recipients: Array<AddressPh | GroupPh>;
  /** «chain enum» without "unstated"; "unstated" is appended here. */
  chains: ChainId[];
}

/** Returns the §12.2 schema object with the «…» slots filled. Same object goes to Ollama `format` and to Ajv. */
export function buildPaymentsSchema(slots: PaymentsSchemaSlots): Record<string, unknown> {
  return {
    $id: 'agent-layer/llm/payments/v1',
    type: 'object',
    additionalProperties: false,
    required: ['payments'],
    properties: {
      payments: {
        type: 'array',
        minItems: 1,
        maxItems: slots.maxItems,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'kind',
            'amount',
            'recipient',
            'chain',
            'frequency',
            'interval',
            'times_per_week',
            'days_of_week',
            'day_of_month',
          ],
          properties: {
            kind: { enum: [...slots.kinds] },
            amount: { enum: [...slots.amounts, null] },
            recipient: { enum: [...slots.recipients] },
            chain: { enum: [...slots.chains, 'unstated'] },
            frequency: { enum: ['daily', 'weekly', 'monthly', null] },
            interval: { enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, null] },
            times_per_week: { enum: [1, 2, 3, 4, 5, 6, 7, null] },
            days_of_week: {
              anyOf: [
                {
                  type: 'array',
                  minItems: 1,
                  maxItems: 7,
                  uniqueItems: true,
                  items: { enum: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] },
                },
                { type: 'null' },
              ],
            },
            day_of_month: {
              enum: [
                1,
                2,
                3,
                4,
                5,
                6,
                7,
                8,
                9,
                10,
                11,
                12,
                13,
                14,
                15,
                16,
                17,
                18,
                19,
                20,
                21,
                22,
                23,
                24,
                25,
                26,
                27,
                28,
                29,
                30,
                31,
                null,
              ],
            },
          },
        },
      },
    },
  };
}
