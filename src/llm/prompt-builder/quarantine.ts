// Implements: §8.10 Q-LLM — Untrusted content extraction (S1): verbatim prompt (src/llm/prompts/quarantine.txt),
// slot {content_text}, §12.1 quarantine schema. §3.2 / §16.1: the Q-LLM never sees the user's prompt.
// Owner: Lane B.

import type { BuiltPrompt } from '../../contracts/llm.js';
import { SCHEMA } from '../../schemas/index.js';
import { fillSlots, loadPromptTemplate } from './amounts.js';

const TEMPLATE = loadPromptTemplate('quarantine.txt');

export function buildQuarantinePrompt(content_text: string): BuiltPrompt {
  return {
    system: TEMPLATE.system,
    user: fillSlots(TEMPLATE.user, { content_text }),
    schema: SCHEMA.quarantine,
  };
}
