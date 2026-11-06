// Implements: §8.10 LLM #2 — Request type (S4): verbatim prompt (src/llm/prompts/requestType.txt), slot
// {masked_text_s3}, §12.1 request-type schema. §16.1: sees the typed words with amounts masked only.
// Owner: Lane B.

import type { BuiltPrompt } from '../../contracts/llm.js';
import { SCHEMA } from '../../schemas/index.js';
import { fillSlots, loadPromptTemplate } from './amounts.js';

const TEMPLATE = loadPromptTemplate('requestType.txt');

export function buildRequestTypePrompt(masked_text_s3: string): BuiltPrompt {
  return {
    system: TEMPLATE.system,
    user: fillSlots(TEMPLATE.user, { masked_text_s3 }),
    schema: SCHEMA.requestType,
  };
}
