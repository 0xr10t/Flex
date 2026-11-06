// Implements: §8.10 prompt builder (one function per LLM call returning {system, user, schema}; fixed text with
// {…} slots filled by code, nothing else added), LLM #1 — Amounts (S3) with the §12.1 amounts schema.
// The prompt text lives verbatim in src/llm/prompts/amounts.txt.
// Owner: Lane B.

import { readFileSync } from 'node:fs';
import type { BuiltPrompt } from '../../contracts/llm.js';
import { SCHEMA } from '../../schemas/index.js';

export interface PromptTemplate {
  system: string;
  user: string;
}

/**
 * Loads a verbatim §8.10 prompt file ("SYSTEM\n…\nUSER\n…") and splits it into its system and user parts.
 * The trailing newline of the file is not part of the prompt.
 */
export function loadPromptTemplate(file: string): PromptTemplate {
  const raw = readFileSync(new URL(`../prompts/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const head = 'SYSTEM\n';
  const sep = '\nUSER\n';
  const i = text.indexOf(sep);
  if (!text.startsWith(head) || i < 0) throw new Error(`prompt file ${file} is malformed`);
  return { system: text.slice(head.length, i), user: text.slice(i + sep.length) };
}

/** Fills `{slot}` occurrences in one pass; only the named slots are touched (JSON braces stay as they are). */
export function fillSlots(template: string, slots: Record<string, string>): string {
  const names = Object.keys(slots).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (names.length === 0) return template;
  return template.replace(new RegExp(`\\{(${names.join('|')})\\}`, 'g'), (_m, name: string) => slots[name] ?? '');
}

const TEMPLATE = loadPromptTemplate('amounts.txt');

/** LLM #1 (S3). Input: `typed_text` (unmasked; §8.4). */
export function buildAmountsPrompt(typed_text: string): BuiltPrompt {
  return {
    system: TEMPLATE.system,
    user: fillSlots(TEMPLATE.user, { typed_text }),
    schema: SCHEMA.amounts,
  };
}
