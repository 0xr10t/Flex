// Guard tests: C-049 §8.0 RequestState / fresh AgentRequest, C-271 §12 shared Ajv instance,
// C-306 §13.4 question shape and chip answer matching.
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { CHIPS, buildQuestion, matchChip } from '../../../src/contracts/catalog.js';
import type { Chip, Question } from '../../../src/contracts/types.js';
import { ajv, compileEphemeral } from '../../../src/schemas/index.js';
import { REQUEST_STATES, newAgentRequest } from '../../../src/session/request.js';

describe('C-049 §8.0 request object', () => {
  it('C-049 §8.0: the 18 RequestState names', () => {
    expect([...REQUEST_STATES]).toEqual([
      'RECEIVED',
      'BALANCES_REFRESHED',
      'GUARDED',
      'SCANNED',
      'AMOUNTS_MASKED',
      'TYPED',
      'SPANS_TAGGED',
      'RECIPIENTS_RESOLVED',
      'RECIPIENTS_MASKED',
      'PAIRED',
      'PLANNED',
      'VALIDATED',
      'AWAITING_CONFIRMATION',
      'HANDED_OFF',
      'HANDOFF_FAILED',
      'ANSWERED',
      'DISCARDED',
      'FAILED',
    ]);
  });

  it('C-049 §8.0: a fresh request has every required field and starts RECEIVED', () => {
    const input = { text: 'hi', pasted_blocks: [], attachments: [], urls: [] };
    const r = newAgentRequest('req_0123456789ab' as never, 'ses_0123456789ab' as never, input);
    expect(r).toMatchObject({
      request_id: 'req_0123456789ab',
      session_id: 'ses_0123456789ab',
      state: 'RECEIVED',
      typed_text: '',
      untrusted: [],
      amounts: [],
      spans: [],
      recipients: [],
      notes: [],
      limit_override: false,
      handoff_attempts: 0,
    });
    expect(r.scan).toBeDefined();
    expect(Object.keys(r.scan).sort()).toEqual(
      [
        'clauses',
        'addresses',
        'ens',
        'groups',
        'chains',
        'tokens',
        'dates',
        'recurrence',
        'cancel',
        'back_reference',
        'distributive',
        'split',
        'numeric_candidates',
      ].sort(),
    );
    for (const optional of [
      'paused_at',
      'request_type',
      'actions',
      'also_balance',
      'masked_text_s8',
      'payments',
      'plan',
    ])
      expect(r, optional).not.toHaveProperty(optional);
  });
});

describe('C-271 §12 shared Ajv instance', () => {
  it('C-271 §12: it is an Ajv2020 (draft 2020-12) with strict and allErrors on', () => {
    expect(ajv).toBeInstanceOf(Ajv2020);
    expect(ajv.opts.strict).toBe(true);
    expect(ajv.opts.allErrors).toBe(true);
    expect(ajv.getSchema('https://json-schema.org/draft/2020-12/schema')).toBeDefined();
  });

  it('C-271 §12: allErrors reports every violation, not just the first', () => {
    const v = compileEphemeral({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'integer' } },
      required: ['a', 'b'],
    });
    expect(v({})).toBe(false);
    expect(v.errors?.length).toBeGreaterThanOrEqual(2);
  });

  it('C-271 §12: strict mode rejects unknown keywords', () => {
    expect(() => compileEphemeral({ type: 'string', notAKeyword: 1 })).toThrow();
  });

  it('C-271 §12: ajv-formats is installed (date-time, uri, date)', () => {
    const v = compileEphemeral({
      type: 'object',
      properties: {
        t: { type: 'string', format: 'date-time' },
        u: { type: 'string', format: 'uri' },
        d: { type: 'string', format: 'date' },
      },
    });
    expect(v({ t: '2026-11-05T10:00:00.000Z', u: 'https://example.com/x', d: '2026-11-05' })).toBe(true);
    expect(v({ t: 'yesterday' })).toBe(false);
    expect(v({ u: 'not a uri' })).toBe(false);
    expect(v({ d: '2026-13-45' })).toBe(false);
  });
});

describe('C-306 §13.4 question shape and chip matching', () => {
  const q = (chips: Chip[]): Question =>
    buildQuestion({
      question_id: 'q_0123456789ab' as never,
      code: 'Q_ADDRESS_CORRECT',
      params: { addr: '0xabc' },
      chips,
    });

  it('C-306 §13.4: question carries question_id, code, text, input, chips, attempt 1, max_attempts 4', () => {
    const question = q([CHIPS.YES, CHIPS.NO_REENTER]);
    expect(question.question_id).toMatch(/^q_[0-9a-f]{12}$/);
    expect(question).toEqual({
      question_id: 'q_0123456789ab',
      code: 'Q_ADDRESS_CORRECT',
      text: 'Is 0xabc correct?',
      input: 'chips',
      chips: [CHIPS.YES, CHIPS.NO_REENTER],
      attempt: 1,
      max_attempts: 4,
    });
    expect(Object.keys(CHIPS.YES).sort()).toEqual(['detail', 'disabled', 'id', 'label']);
  });

  it('C-306 §13.4: a chip answer matches by chip_id', () => {
    const question = q([CHIPS.YES, CHIPS.NO_REENTER]);
    expect(matchChip(question, { kind: 'chip', chip_id: 'no_reenter' })).toBe(CHIPS.NO_REENTER);
    expect(matchChip(question, { kind: 'chip', chip_id: 'nope' })).toBeNull();
  });

  it('C-306 §13.4: a free-text answer matches a chip label case-insensitively', () => {
    const question = q([CHIPS.YES, CHIPS.NO_REENTER]);
    expect(matchChip(question, { kind: 'text', text: 'NO, RE-ENTER' })).toBe(CHIPS.NO_REENTER);
    expect(matchChip(question, { kind: 'text', text: 'yEs' })).toBe(CHIPS.YES);
  });

  it('C-306 §13.4: "yes" / "no" match the Yes / No chips', () => {
    const question = buildQuestion({
      question_id: 'q_0123456789ab' as never,
      code: 'Q_AMOUNT_UNCOVERED',
      params: { n: '5' },
      chips: [CHIPS.YES, CHIPS.NO],
    });
    expect(matchChip(question, { kind: 'text', text: 'yes' })).toBe(CHIPS.YES);
    expect(matchChip(question, { kind: 'text', text: 'no' })).toBe(CHIPS.NO);
  });

  it('C-306 §13.4: free text that is not a chip label is invalid', () => {
    const question = q([CHIPS.YES, CHIPS.NO_REENTER]);
    expect(matchChip(question, { kind: 'text', text: 'maybe' })).toBeNull();
    expect(matchChip(question, { kind: 'text', text: 'no' })).toBeNull();
  });
});
