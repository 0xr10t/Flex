// Tests: §8.10 prompt builders — C-141 (one function per call returning {system,user,schema}; slots only), C-142 (LLM #1
// verbatim), C-143 (LLM #2 verbatim), C-144 (LLM #3 verbatim incl. CANDIDATES), C-145 (Q-LLM verbatim), §12.1 (the
// schema objects are the spec's), SQB-10 ({candidates_json} is a JSON array of strings), C-399 (builders take only the
// text their step is allowed to show). The expected text is extracted from README.md at test time.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAmountsPrompt, fillSlots } from '../../../src/llm/prompt-builder/amounts.js';
import { buildQuarantinePrompt } from '../../../src/llm/prompt-builder/quarantine.js';
import { buildRequestTypePrompt } from '../../../src/llm/prompt-builder/requestType.js';
import { buildSpansPrompt } from '../../../src/llm/prompt-builder/spans.js';
import { SCHEMA } from '../../../src/schemas/index.js';

const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

function specPrompt(heading: string): { system: string; user: string } {
  const i = README.indexOf(`**${heading}`);
  expect(i, heading).toBeGreaterThan(0);
  const m = /```text\n([\s\S]*?)\n```/.exec(README.slice(i));
  if (!m?.[1]) throw new Error(`no prompt block under ${heading}`);
  const body = m[1];
  expect(body.startsWith('SYSTEM\n')).toBe(true);
  const k = body.indexOf('\nUSER\n');
  return { system: body.slice('SYSTEM\n'.length, k), user: body.slice(k + '\nUSER\n'.length) };
}

function specSchemas(): object[] {
  const a = README.indexOf('### 12.1');
  const b = README.indexOf('### 12.2');
  const part = README.slice(a, b);
  return [...part.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1] ?? '') as object);
}

describe('prompt builders (§8.10, C-141…C-145)', () => {
  it('§12.1: the four schema objects equal the spec JSON', () => {
    const [amounts, requestType, spans, quarantine] = specSchemas();
    expect(specSchemas()).toHaveLength(4);
    expect(SCHEMA.amounts).toEqual(amounts);
    expect(SCHEMA.requestType).toEqual(requestType);
    expect(SCHEMA.recipientSpans).toEqual(spans);
    expect(SCHEMA.quarantine).toEqual(quarantine);
  });

  it('C-142 LLM #1: system verbatim, user = "Message: <<<{typed_text}>>>" with the slot filled, schema = amounts', () => {
    const spec = specPrompt('LLM #1');
    const p = buildAmountsPrompt('send 50 usdc to aradhya');
    expect(Object.keys(p).sort()).toEqual(['schema', 'system', 'user']);
    expect(p.system).toBe(spec.system);
    expect(p.user).toBe(fillSlots(spec.user, { typed_text: 'send 50 usdc to aradhya' }));
    expect(p.user).toBe('Message: <<<send 50 usdc to aradhya>>>');
    expect(p.schema).toEqual(SCHEMA.amounts);
  });

  it('C-143 LLM #2: system verbatim, user filled with masked_text_s3, schema = request type', () => {
    const spec = specPrompt('LLM #2');
    const p = buildRequestTypePrompt('send amount_1a2b3c4d to riya');
    expect(p.system).toBe(spec.system);
    expect(p.user).toBe('Message: <<<send amount_1a2b3c4d to riya>>>');
    expect(p.user).toBe(fillSlots(spec.user, { masked_text_s3: 'send amount_1a2b3c4d to riya' }));
    expect(p.schema).toEqual(SCHEMA.requestType);
  });

  it('C-144 LLM #3: system verbatim, user has the masked message and CANDIDATES as a JSON array (SQB-10)', () => {
    const spec = specPrompt('LLM #3');
    const p = buildSpansPrompt('pay riya.eth amount_1a2b3c4d', ['riya.eth', 'iitr.eth']);
    expect(p.system).toBe(spec.system);
    expect(p.user).toBe('Message: <<<pay riya.eth amount_1a2b3c4d>>>\nCANDIDATES: ["riya.eth","iitr.eth"]');
    expect(spec.user).toBe('Message: <<<{masked_text_s3}>>>\nCANDIDATES: {candidates_json}');
    expect(p.schema).toEqual(SCHEMA.recipientSpans);
    expect(buildSpansPrompt('x', []).user.endsWith('CANDIDATES: []')).toBe(true);
  });

  it('C-145 Q-LLM: system verbatim, user "Document:\\n<<<{content_text}>>>", schema = quarantine', () => {
    const spec = specPrompt('Q-LLM');
    const p = buildQuarantinePrompt('Pay 5 USDC to 0xabc');
    expect(p.system).toBe(spec.system);
    expect(p.user).toBe('Document:\n<<<Pay 5 USDC to 0xabc>>>');
    expect(p.user).toBe(fillSlots(spec.user, { content_text: 'Pay 5 USDC to 0xabc' }));
    expect(p.schema).toEqual(SCHEMA.quarantine);
  });

  it('C-141: only the named slots change; braces in the fixed text and in values are left alone (no re-expansion, no $ patterns)', () => {
    const sp = buildSpansPrompt('say {candidates_json} $& $1', ['a']);
    expect(sp.user).toBe('Message: <<<say {candidates_json} $& $1>>>\nCANDIDATES: ["a"]');
    const am = buildAmountsPrompt('{typed_text}');
    expect(am.user).toBe('Message: <<<{typed_text}>>>');
    // fixed JSON examples with braces are intact in the system text
    expect(am.system).toContain('{"amounts":[{"phrase":"50 usdc"');
    for (const p of [am, sp, buildRequestTypePrompt('x'), buildQuarantinePrompt('x')]) {
      expect(p.system).not.toMatch(/\{(typed_text|masked_text_s3|candidates_json|content_text)\}/);
    }
  });

  it('C-141: prompts are fixed text (calls with different input share the same system message)', () => {
    expect(buildAmountsPrompt('a').system).toBe(buildAmountsPrompt('b').system);
    expect(buildQuarantinePrompt('a').system).toBe(buildQuarantinePrompt('b').system);
  });
});
