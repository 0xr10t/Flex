// contracts-v4: SQ-D-16 F-1…F-6 (Q_LIMIT_OVERRIDE), SQ-O-03 F-11 (Q_PAIR_AMOUNT), SQ-O-01 F-12 (Q_NAME_ROLE),
// SQ-08 F-10 (INSUFFICIENT_FUNDS chains), SQ-O-10 (SILENT_REUSE chains), cancel / limit notes.
import { describe, expect, it } from 'vitest';
import {
  CHIPS,
  ERROR_MESSAGE,
  LIMIT_OVERRIDE,
  LIMIT_OVERRIDE_YES_NO,
  NAME_ROLE,
  NAME_ROLE_CHIP,
  NAME_ROLE_YES_NO,
  NOTES,
  PAIR_AMOUNT,
  QUESTION_INPUT,
  QUESTION_TEXT,
  REPLY,
  buildQuestion,
  insufficientFundsParams,
  joinList,
  limitOverrideLead,
  matchChip,
  type BrokenLimit,
} from '../../../src/contracts/catalog.js';
import { QUESTION_CODES, type Question } from '../../../src/contracts/types.js';

const perPayment = (max: string, repeating = false): BrokenLimit => ({
  kind: 'per_payment',
  max,
  token: 'USDC',
  repeating,
});

describe('contracts-v4 question catalogue', () => {
  it('SQ-D-16 SQ-O-03 SQ-O-01 F-1 F-11 F-12: 28 codes; Q_GROUP_OVER_LIMIT gone, three new ones present', () => {
    expect(QUESTION_CODES).toHaveLength(28);
    expect(QUESTION_CODES).not.toContain('Q_GROUP_OVER_LIMIT');
    expect(QUESTION_CODES).toContain('Q_LIMIT_OVERRIDE');
    expect(QUESTION_CODES).toContain('Q_PAIR_AMOUNT');
    expect(QUESTION_CODES).toContain('Q_NAME_ROLE');
    for (const c of ['Q_LIMIT_OVERRIDE', 'Q_PAIR_AMOUNT', 'Q_NAME_ROLE'] as const) {
      expect(QUESTION_TEXT[c]).toBeTypeOf('function');
      expect(QUESTION_INPUT[c]).toBe('chips');
    }
  });
});

describe('joinList', () => {
  it('SQ-06 F-10: joins 0, 1, 2 and 3 items', () => {
    expect(joinList([])).toBe('');
    expect(joinList(['A'])).toBe('A');
    expect(joinList(['A', 'B'])).toBe('A and B');
    expect(joinList(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('Q_LIMIT_OVERRIDE text and chips', () => {
  it('SQ-D-16 F-1: per-payment and daily broken together share one "over"', () => {
    const a = {
      broken: [
        perPayment('100'),
        { kind: 'daily', daily_max: '300', remaining: '40', token: 'USDC', repeating: false },
      ] as BrokenLimit[],
      amount: { value: '150', token: 'USDC' as const },
    };
    expect(limitOverrideLead(a)).toBe(
      "This is 150 USDC, over your per-payment limit of 100 and today's limit of 300 (only 40 is left).",
    );
    expect(LIMIT_OVERRIDE.text(a)).toBe(
      "This is 150 USDC, over your per-payment limit of 100 and today's limit of 300 (only 40 is left). Go ahead this once?",
    );
    expect(LIMIT_OVERRIDE.chips(a).map((c) => [c.id, c.label])).toEqual([
      ['override', 'Yes, this once'],
      ['no', 'No'],
    ]);
  });

  it('SQ-D-16: a single per-payment limit', () => {
    const a = { broken: [perPayment('100')], amount: { value: '120', token: 'USDC' as const } };
    expect(LIMIT_OVERRIDE.text(a)).toBe('This is 120 USDC, over your per-payment limit of 100. Go ahead this once?');
  });

  it('SQ-D-16 F-3: autopay period limit asks "Set it up anyway?" with set-up chips', () => {
    const a = { broken: [{ kind: 'autopay_period', max: '100', token: 'USDC', repeating: true } as BrokenLimit] };
    expect(LIMIT_OVERRIDE.repeating(a)).toBe(true);
    expect(LIMIT_OVERRIDE.text(a)).toBe(
      'This repeating payment is over your weekly autopay limit of 100. Set it up anyway?',
    );
    expect(LIMIT_OVERRIDE.chips(a).map((c) => [c.id, c.label])).toEqual([
      ['override', 'Yes, set it up'],
      ['no', 'No'],
    ]);
  });

  it('SQ-D-16 F-3: autopay duration limit', () => {
    const a = { broken: [{ kind: 'autopay_duration', weeks: '52', repeating: true } as BrokenLimit] };
    expect(LIMIT_OVERRIDE.text(a)).toBe(
      'This repeating payment is over the 52-week limit for repeating payments. Set it up anyway?',
    );
  });

  it('SQ-D-16 F-4: bridges limit', () => {
    const a = { broken: [{ kind: 'bridges', n: '4', max: '3', repeating: false } as BrokenLimit] };
    expect(LIMIT_OVERRIDE.text(a)).toBe('This needs 4 transfers between chains; your limit is 3. Go ahead this once?');
    expect(LIMIT_OVERRIDE.chips(a).map((c) => [c.id, c.label])).toEqual([
      ['override', 'Yes, this once'],
      ['no', 'No'],
    ]);
  });

  it('SQ-D-16 F-1: mixed tokens name the token after each figure and drop the "This is N TOKEN" amount', () => {
    const a = {
      broken: [perPayment('100'), { kind: 'per_payment', max: '0.5', token: 'ETH', repeating: false }] as BrokenLimit[],
      amount: { value: '150', token: 'USDC' as const },
    };
    expect(limitOverrideLead(a)).toBe(
      'This is over your per-payment limit of 100 USDC and your per-payment limit of 0.5 ETH.',
    );
  });

  it('SQ-D-16 F-1: three "over" items join as "A, B and C"', () => {
    const a = {
      broken: [
        perPayment('100'),
        { kind: 'daily', daily_max: '300', remaining: '40', token: 'USDC', repeating: false },
        { kind: 'autopay_period', max: '100', token: 'USDC', repeating: true },
      ] as BrokenLimit[],
      amount: { value: '150', token: 'USDC' as const },
    };
    const lead = limitOverrideLead(a);
    expect(lead).toBe(
      "This is 150 USDC, over your per-payment limit of 100, today's limit of 300 (only 40 is left) and your weekly autopay limit of 100.",
    );
    // any repeating limit picks the "Set it up anyway?" closing
    expect(LIMIT_OVERRIDE.text(a).endsWith('Set it up anyway?')).toBe(true);
  });

  it('SQ-D-16 F-4: bridges combined with an over-limit', () => {
    const a = {
      broken: [perPayment('100'), { kind: 'bridges', n: '4', max: '3', repeating: false }] as BrokenLimit[],
      amount: { value: '150', token: 'USDC' as const },
    };
    expect(limitOverrideLead(a)).toBe(
      'This is 150 USDC, over your per-payment limit of 100 and needs 4 transfers between chains; your limit is 3.',
    );
  });

  it('SQ-D-16 F-1: matchChip with the yesNo argument maps typed yes / no onto override / no', () => {
    const a = { broken: [perPayment('100')], amount: { value: '120', token: 'USDC' as const } };
    const q = buildQuestion({
      question_id: 'q_1',
      code: 'Q_LIMIT_OVERRIDE',
      text: LIMIT_OVERRIDE.text(a),
      chips: LIMIT_OVERRIDE.chips(a),
    });
    expect(matchChip(q, { kind: 'text', text: ' Yes ' }, LIMIT_OVERRIDE_YES_NO)?.id).toBe('override');
    expect(matchChip(q, { kind: 'text', text: 'no' }, LIMIT_OVERRIDE_YES_NO)?.id).toBe('no');
    expect(matchChip(q, { kind: 'chip', chip_id: 'override' }, LIMIT_OVERRIDE_YES_NO)?.label).toBe('Yes, this once');
    expect(matchChip(q, { kind: 'text', text: 'maybe' }, LIMIT_OVERRIDE_YES_NO)).toBeNull();
    // without yesNo the plain "Yes" label rule finds nothing (no chip is labelled exactly "Yes")
    expect(matchChip(q, { kind: 'text', text: 'yes' })).toBeNull();
  });
});

describe('Q_PAIR_AMOUNT', () => {
  it('SQ-O-03 F-11: text and one chip per recipient', () => {
    expect(PAIR_AMOUNT.text({ amount: '10', token: 'USDC' })).toBe('Who should get 10 USDC?');
    expect(
      PAIR_AMOUNT.chips([
        { id: 'recipient_a1', label: 'Mihir' },
        { id: 'recipient_b2', label: 'Riya' },
      ]).map((c) => [c.id, c.label]),
    ).toEqual([
      ['recipient_a1', 'Mihir'],
      ['recipient_b2', 'Riya'],
    ]);
    expect(QUESTION_TEXT.Q_PAIR_AMOUNT({ amount: '0.01', token: 'ETH' })).toBe('Who should get 0.01 ETH?');
  });
});

describe('Q_NAME_ROLE', () => {
  it('SQ-O-01 F-12: text, chips and typed yes / no mapping', () => {
    expect(NAME_ROLE.text({ name: 'Mihir' })).toBe('Should I pay Mihir?');
    expect(NAME_ROLE.chips({ name: 'Mihir' }).map((c) => [c.id, c.label])).toEqual([
      ['pay', 'Yes, pay Mihir'],
      ['only_mentioned', "No, they're only mentioned"],
    ]);
    expect(NAME_ROLE_CHIP).toEqual({ PAY: 'pay', MENTIONED: 'only_mentioned' });
    const q = buildQuestion({
      question_id: 'q_2',
      code: 'Q_NAME_ROLE',
      text: NAME_ROLE.text({ name: 'Mihir' }),
      chips: NAME_ROLE.chips({ name: 'Mihir' }),
    });
    expect(matchChip(q, { kind: 'text', text: 'yes' }, NAME_ROLE_YES_NO)?.id).toBe('pay');
    expect(matchChip(q, { kind: 'text', text: 'No' }, NAME_ROLE_YES_NO)?.id).toBe('only_mentioned');
  });

  it('SQ-O-01 F-12: matchChip skips a disabled chip even for a typed yes', () => {
    const q: Question = buildQuestion({
      question_id: 'q_3',
      code: 'Q_NAME_ROLE',
      text: NAME_ROLE.text({ name: 'Mihir' }),
      chips: NAME_ROLE.chips({ name: 'Mihir' }).map((c) => (c.id === 'pay' ? { ...c, disabled: true } : c)),
    });
    expect(matchChip(q, { kind: 'text', text: 'yes' }, NAME_ROLE_YES_NO)).toBeNull();
  });
});

describe('INSUFFICIENT_FUNDS (F-10)', () => {
  const render = (a: Parameters<typeof insufficientFundsParams>[0]): string =>
    ERROR_MESSAGE.INSUFFICIENT_FUNDS(insufficientFundsParams(a));

  it('SQ-08 F-10: lists the positive chains', () => {
    expect(
      render({
        token: 'USDC',
        need: '150',
        have: '140',
        chains: [
          { name: 'Base Sepolia', spendable: '80' },
          { name: 'Arbitrum Sepolia', spendable: '60' },
        ],
      }),
    ).toBe(
      "You don't have enough USDC: you need 150, and can use 140 across Base Sepolia (80) and Arbitrum Sepolia (60).",
    );
  });

  it('SQ-08 F-10: zero chains gives "can use 0." with no "across"', () => {
    expect(render({ token: 'USDC', need: '150', have: '0', chains: [] })).toBe(
      "You don't have enough USDC: you need 150, and can use 0.",
    );
  });

  it('SQ-08 F-10: zero-spendable entries are dropped', () => {
    const p = insufficientFundsParams({
      token: 'USDC',
      need: '150',
      have: '80',
      chains: [
        { name: 'Sepolia', spendable: '0' },
        { name: 'Base Sepolia', spendable: '80' },
        { name: 'Arbitrum Sepolia', spendable: '0.0' },
      ],
    });
    expect(p.chains).toBe('Base Sepolia (80)');
    expect(ERROR_MESSAGE.INSUFFICIENT_FUNDS(p)).toBe(
      "You don't have enough USDC: you need 150, and can use 80 across Base Sepolia (80).",
    );
  });

  it('SQ-08 F-10: keeps config order and a three-chain list', () => {
    const p = insufficientFundsParams({
      token: 'ETH',
      need: '1',
      have: '0.6',
      chains: [
        { name: 'Sepolia', spendable: '0.1' },
        { name: 'Base Sepolia', spendable: '0.2' },
        { name: 'Arbitrum Sepolia', spendable: '0.3' },
      ],
    });
    expect(p.chains).toBe('Sepolia (0.1), Base Sepolia (0.2) and Arbitrum Sepolia (0.3)');
  });
});

describe('contracts-v4 notes and replies', () => {
  it('SQ-D-16 F-2: LIMIT_LIFTED note', () => {
    expect(NOTES.LIMIT_LIFTED()).toBe('A limit was lifted once for this request.');
  });

  it('SQ-O-10: SILENT_REUSE names every chain with the reused address', () => {
    expect(NOTES.SILENT_REUSE({ chains: joinList(['Base Sepolia', 'Arbitrum Sepolia']) })).toBe(
      'Same address as on Base Sepolia and Arbitrum Sepolia.',
    );
    expect(NOTES.SILENT_REUSE({ chains: 'Base Sepolia' })).toBe('Same address as on Base Sepolia.');
  });

  it('SQ-A-01 F-8: CANCEL_AFTER_HANDOFF reply', () => {
    expect(REPLY.CANCEL_AFTER_HANDOFF()).toBe(
      "That was already sent to your wallet for signing, so it can't be cancelled here.",
    );
  });

  it('SQ-D-16: the generic CHIPS.NO chip is id "no"', () => {
    expect(CHIPS.NO.id).toBe('no');
  });
});
