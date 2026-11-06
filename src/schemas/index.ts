// Implements: §12 (one shared Ajv instance: draft 2020-12, strict, allErrors; ajv-formats), §12.1, §12.3, §12.5.
// Owned by the Orchestrator. Schema JSON files are verbatim copies of the spec (internal-plan is generated
// by scripts/gen-internal-plan-schema.mjs from src/contracts/types.ts).

import { readFileSync } from 'node:fs';
import { envelopeSchema } from '@flex/protocol';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

// ajv-formats ships CJS; under NodeNext the default import is the module object.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

function load(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

export const SCHEMA = {
  amounts: load('llm-amounts.schema.json'),
  requestType: load('llm-request-type.schema.json'),
  recipientSpans: load('llm-recipient-spans.schema.json'),
  quarantine: load('llm-quarantine.schema.json'),
  handoffEnvelope: envelopeSchema,
  internalPlan: load('internal-plan.schema.json'),
} as const;

/** The one Ajv instance (§12). `allowUnionTypes` is needed for the spec's `"type": ["string","null"]`. */
export const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
addFormats(ajv);

export const validators = {
  amounts: ajv.compile(SCHEMA.amounts),
  requestType: ajv.compile(SCHEMA.requestType),
  recipientSpans: ajv.compile(SCHEMA.recipientSpans),
  quarantine: ajv.compile(SCHEMA.quarantine),
  handoffEnvelope: ajv.compile(SCHEMA.handoffEnvelope),
  internalPlan: ajv.compile(SCHEMA.internalPlan),
} as const;

/**
 * Compiles a per-request schema (§12.2) without registering its `$id` globally
 * (every S8 call uses the same `$id` with different enums).
 */
export function compileEphemeral(schema: Record<string, unknown>): ValidateFunction {
  const { $id: _ignored, ...rest } = schema;
  return ajv.compile(rest);
}

export { buildPaymentsSchema } from './payments-template.js';
