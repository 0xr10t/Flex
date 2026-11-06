// Lane D tester: §8.10 LLM #4 prompt builder, §8.9 / §12.2 per-request schema slots.
// SQ-L-01 permits reviewed system text changes; full live acceptance is recorded in PROMPT_CHANGES.md.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AddressPh, AmountPh, GroupPh } from '../../../src/contracts/types.js';
import {
  PAYMENTS_PROMPT_TEMPLATE,
  buildPaymentsPrompt,
  paymentsMaxItems,
  type PaymentsPromptInput,
} from '../../../src/llm/prompt-builder/payments.js';
import { buildPaymentsSchema, compileEphemeral } from '../../../src/schemas/index.js';

/** The §8.10 "LLM #4 — Pair payments (S8)" block, read from the spec itself. */
function specBlock(): { system: string; user: string } {
  const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
  const start = readme.indexOf('**LLM #4 — Pair payments (S8)**');
  const open = readme.indexOf('```text\n', start) + '```text\n'.length;
  const close = readme.indexOf('\n```', open);
  const block = readme.slice(open, close);
  const lines = block.split('\n');
  const s = lines.indexOf('SYSTEM');
  const u = lines.indexOf('USER');
  return { system: lines.slice(s + 1, u).join('\n'), user: lines.slice(u + 1).join('\n') };
}

function reviewedBlock(): { system: string; user: string } {
  const block = readFileSync(new URL('../../fixtures/prompts/payments.txt', import.meta.url), 'utf8').trimEnd();
  const split = block.indexOf('\nUSER\n');
  expect(block.startsWith('SYSTEM\n')).toBe(true);
  expect(split).toBeGreaterThan(0);
  return { system: block.slice('SYSTEM\n'.length, split), user: block.slice(split + '\nUSER\n'.length) };
}

const A1 = 'amount_7f2c1a90' as AmountPh;
const A2 = 'amount_02bd6e15' as AmountPh;
const R1 = 'address_91ab33f0' as AddressPh;
const R2 = 'address_5c7e2a41' as AddressPh;
const G1 = 'group_0a0b0c0d' as GroupPh;
const S1 = 'address_0f1e2d3c' as AddressPh;

function input(over: Partial<PaymentsPromptInput> = {}): PaymentsPromptInput {
  return {
    masked_text_s8: `pay ${R1} ${A1} every friday`,
    amounts: [{ placeholder: A1, token: 'USDC', from_attached_content: false }],
    recipients: [{ placeholder: R1, type: 'person' }],
    doc_items: 'none',
    chains: [],
    actions: ['k'],
    session: 'none',
    ...over,
  };
}

describe('LLM #4 prompt builder (§8.10)', () => {
  it('C-148 / SQ-L-01 system text equals the independently reviewed recurrence and chain instructions', () => {
    const p = buildPaymentsPrompt(input());
    expect(p.system).toBe(reviewedBlock().system);
  });

  it('C-148 / SQ-L-01 PAYMENTS_PROMPT_TEMPLATE preserves every USER slot from the spec', () => {
    const reviewed = reviewedBlock();
    // SQ-21: the spec's inline comments describe slots and are not sent to the model.
    const specUser = specBlock()
      .user.split('\n')
      .map((line) => line.replace(/\s+\/\/.*$/, ''))
      .join('\n');
    expect(reviewed.user).toBe(specUser);
    expect(PAYMENTS_PROMPT_TEMPLATE).toBe(`SYSTEM\n${reviewed.system}\nUSER\n${reviewed.user}`);
    for (const slot of [
      'Message: <<<{masked_text_s8}>>>',
      'AMOUNTS: {amounts_json}',
      'RECIPIENTS: {recipients_json}',
      'DOCUMENT ITEMS: {doc_items_json}',
      'CHAINS MENTIONED: {chains_json}',
      'ACTION KINDS: {actions_json}',
      'SESSION: {session_json}',
      '{correction_line}',
    ]) {
      expect(PAYMENTS_PROMPT_TEMPLATE).toContain(slot);
    }
  });

  it('C-148 §8.10 user message fills every slot with compact JSON and omits the correction line', () => {
    const p = buildPaymentsPrompt(input());
    expect(p.user).toBe(
      [
        `Message: <<<pay ${R1} ${A1} every friday>>>`,
        `AMOUNTS: [{"placeholder":"${A1}","token":"USDC","from_attached_content":false}]`,
        `RECIPIENTS: [{"placeholder":"${R1}","type":"person"}]`,
        'DOCUMENT ITEMS: none',
        'CHAINS MENTIONED: []',
        'ACTION KINDS: ["k"]',
        'SESSION: none',
      ].join('\n'),
    );
    expect(p.user).not.toContain('CORRECTION');
    expect(p.user).not.toContain('//');
  });

  it('C-148 C-130 §8.9 retry: correction rendered as a final "CORRECTION: <problems>" line', () => {
    const p = buildPaymentsPrompt(input({ correction: `${A1} is not used.` }));
    const lines = p.user.split('\n');
    expect(lines[lines.length - 1]).toBe(`CORRECTION: ${A1} is not used.`);
    expect(lines.filter((l) => l.startsWith('CORRECTION: '))).toHaveLength(1);
  });

  it('C-148 §8.10 group recipients, document items, chains and SESSION rendered as JSON', () => {
    const p = buildPaymentsPrompt(
      input({
        masked_text_s8: `send ${A1} to ${G1} on base, and ${A2} to ${R2} and ${S1}`,
        amounts: [
          { placeholder: A1, token: 'USDC', from_attached_content: false },
          { placeholder: A2, token: 'ETH', from_attached_content: true },
        ],
        recipients: [
          { placeholder: G1, type: 'group' },
          { placeholder: R2, type: 'person' },
        ],
        doc_items: [{ amount: A2, recipient: R2 }],
        chains: [{ word: 'base', chain_id: 84532 }],
        actions: ['i'],
        session: [{ placeholder: S1, last_chain_id: 84532 }],
      }),
    );
    const lines = p.user.split('\n');
    expect(lines).toContain(
      `AMOUNTS: [{"placeholder":"${A1}","token":"USDC","from_attached_content":false},{"placeholder":"${A2}","token":"ETH","from_attached_content":true}]`,
    );
    expect(lines).toContain(
      `RECIPIENTS: [{"placeholder":"${G1}","type":"group"},{"placeholder":"${R2}","type":"person"}]`,
    );
    expect(lines).toContain(`DOCUMENT ITEMS: [{"amount":"${A2}","recipient":"${R2}"}]`);
    expect(lines).toContain('CHAINS MENTIONED: [{"word":"base","chain_id":84532}]');
    expect(lines).toContain('ACTION KINDS: ["i"]');
    expect(lines).toContain(`SESSION: [{"placeholder":"${S1}","last_chain_id":84532}]`);
  });
});

describe('S8 per-request schema (§8.9, §12.2)', () => {
  it('C-128 §8.9 maxItems = min(50, A×R + R)', () => {
    expect(paymentsMaxItems(1, 1)).toBe(2);
    expect(paymentsMaxItems(2, 3)).toBe(9);
    expect(paymentsMaxItems(0, 1)).toBe(1);
    expect(paymentsMaxItems(10, 10)).toBe(50);
    expect(paymentsMaxItems(4, 10)).toBe(50);
    expect(paymentsMaxItems(3, 12)).toBe(48);
  });

  it('C-123 C-124 C-125 C-126 C-127 §12.2 schema = template filled with kinds, amounts+null, recipients, unique chains+"unstated"', () => {
    const p = buildPaymentsPrompt(
      input({
        amounts: [
          { placeholder: A1, token: 'USDC', from_attached_content: false },
          { placeholder: A2, token: 'USDC', from_attached_content: false },
        ],
        recipients: [
          { placeholder: R1, type: 'person' },
          { placeholder: G1, type: 'group' },
        ],
        chains: [
          { word: 'arbitrum', chain_id: 421614 },
          { word: 'base', chain_id: 84532 },
          { word: 'arb', chain_id: 421614 },
        ],
        actions: ['i', 'k'],
        session: [{ placeholder: S1, last_chain_id: null }],
      }),
    );
    // A = 2, R = 2 recipients + 1 session → min(50, 2×3 + 3) = 9.
    expect(p.schema).toEqual(
      buildPaymentsSchema({
        maxItems: 9,
        kinds: ['i', 'k'],
        amounts: [A1, A2],
        recipients: [R1, G1, S1],
        chains: [421614, 84532],
      }),
    );
    const props = (p.schema as { properties: { payments: { items: { properties: Record<string, unknown> } } } })
      .properties.payments.items.properties;
    expect(props.kind).toEqual({ enum: ['i', 'k'] });
    expect(props.amount).toEqual({ enum: [A1, A2, null] });
    expect(props.recipient).toEqual({ enum: [R1, G1, S1] });
    expect(props.chain).toEqual({ enum: [421614, 84532, 'unstated'] });
    expect(props.frequency).toEqual({ enum: ['daily', 'weekly', 'monthly', null] });
    expect(props.times_per_week).toEqual({ enum: [1, 2, 3, 4, 5, 6, 7, null] });
  });

  it('C-127 §12.2 schedule enums reject values outside the template (interval 13, day_of_month 32)', () => {
    const p = buildPaymentsPrompt(input());
    const v = compileEphemeral(p.schema as Record<string, unknown>);
    const base = {
      kind: 'k',
      amount: A1,
      recipient: R1,
      chain: 'unstated',
      frequency: 'weekly',
      interval: 1,
      times_per_week: null,
      days_of_week: ['FRI'],
      day_of_month: null,
    };
    expect(v({ payments: [base] })).toBe(true);
    expect(v({ payments: [{ ...base, interval: 13 }] })).toBe(false);
    expect(v({ payments: [{ ...base, day_of_month: 32 }] })).toBe(false);
    expect(v({ payments: [{ ...base, days_of_week: ['FRI', 'FRI'] }] })).toBe(false);
    expect(v({ payments: [{ ...base, kind: 'i' }] })).toBe(false);
    expect(v({ payments: [{ ...base, chain: 84532 }] })).toBe(false);
  });
});
