// Implements: §8.10 LLM #3 — Recipient spans (S5): verbatim prompt (src/llm/prompts/spans.txt), slots
// {masked_text_s3} and {candidates_json} (§8.6: every address, ENS and group candidate from S2, text exactly as in
// the masked text), §12.1 recipient-spans schema. §16.1: sees the typed words with amounts masked only.
// Owner: Lane B.

import type { BuiltPrompt } from '../../contracts/llm.js';
import { SCHEMA } from '../../schemas/index.js';
import { fillSlots, loadPromptTemplate } from './amounts.js';

const TEMPLATE = loadPromptTemplate('spans.txt');

/** `candidates` are the candidate texts; they are rendered as a JSON array of strings (SQB-10). */
export function buildSpansPrompt(masked_text_s3: string, candidates: readonly string[]): BuiltPrompt {
  return {
    system: TEMPLATE.system,
    user: fillSlots(TEMPLATE.user, { masked_text_s3, candidates_json: JSON.stringify(candidates) }),
    schema: SCHEMA.recipientSpans,
  };
}
