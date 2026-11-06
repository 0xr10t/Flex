// Lane D tester: S11 summary (§13.1), balance answer (§13.2), fixed replies (§13.3), also_balance (SQB-15).
import { describe, expect, it, vi } from 'vitest';
import { NOTES, REPLY } from '../../../src/contracts/catalog.js';
import { shortAddress } from '../../../src/contracts/money.js';
import type { AddressPh, InternalIntent, Schedule } from '../../../src/contracts/types.js';
import { buildBalanceAnswer } from '../../../src/messages/balance.js';
import { buildSummary, cadenceText } from '../../../src/messages/summary.js';
import { s11 } from '../../../src/pipeline/s11-summary.js';
import type { TestContext } from '../../fakes/context.js';
import {
  ALICE_CS,
  ARADHYA_CS,
  ARB,
  BASE,
  BOB_CS,
  DOC_ADDR_CS,
  MIHIR_CS,
  SEPOLIA,
  addAmount,
  addAradhya,
  addAutopay,
  addChrono,
  addGroup,
  addMihir,
  addRecipient,
  ctxD,
  db6Row,
  mintAmount,
  pay,
  planI,
  planJ,
  planK,
  planL,
  sched,
  setClauses,
  setLimits,
  weekly,
} from './helpers.js';
import { iPay, kSetup, run, usdc } from './s9-helpers.js';

vi.mock('../../../src/amounts/parse.js', async () => {
  const m = await import('./parse-mock.js');
  return { parseAmountText: (t: string) => m.fakeParseAmountText(t) };
});

const ADDR_ARADHYA = '0x3fA9…c21E';
// Spec §19 writes Mihir as 0x91aB…77d0, which is not a valid EIP-55 checksum; getAddress gives 0x91Ab…77d0 (spec data ambiguity).
const ADDR_MIHIR = '0x91Ab…77d0';

function build(ctx: TestContext, plan: InternalIntent[]): ReturnType<typeof buildSummary> {
  ctx.req.plan = plan;
  return buildSummary(ctx, plan);
}

/** A k plan with a given schedule (Mihir on Base). */
function kLine(schedule: Schedule): string {
  const ctx = ctxD({ actions: ['k'], balances: usdc('0', '1000', '0') });
  const mi = addMihir(ctx);
  return build(ctx, [planK(ctx, 0, mi, BASE, { schedule })]).lines[0] as string;
}

const E6_END = { type: 'on_date', date: '2026-12-31' } as const;

describe('§13.1 line templates', () => {
  it('C-279 §13.1 j line (E3): Move … (your own account; includes a 2% fee buffer, anything left over stays with you).', () => {
    const ctx = ctxD({ balances: usdc('0', '30', '50') });
    const j = planJ(ctx, 0, ARB, BASE, '10.2', '10', [1]);
    const a = addAradhya(ctx);
    const i = planI(1, mintAmount(ctx, '40'), a, BASE, { depends_on: [0] });
    const s = build(ctx, [j, i]);
    expect(s.lines[0]).toBe(
      '1. Move 10.2 USDC from Arbitrum Sepolia to Base Sepolia (your own account; includes a 2% fee buffer, anything left over stays with you).',
    );
  });

  it('C-279 §13.1 j line uses the configured bridge_buffer_pct for {b}', () => {
    const ctx = ctxD({ balances: usdc('0', '30', '50') });
    setLimits(ctx, { bridge_buffer_pct: '3.5' });
    const j = planJ(ctx, 0, ARB, BASE, '10.2', '10', [1]);
    const a = addAradhya(ctx);
    const s = build(ctx, [j, planI(1, mintAmount(ctx, '40'), a, BASE, { depends_on: [0] })]);
    expect(s.lines[0]).toContain('includes a 3.5% fee buffer');
  });

  it('C-280 §13.1 i line: Send {amount} {token} to {Name} ({addr}) on {Chain}. (no suffix without depends_on)', () => {
    const ctx = ctxD({ balances: usdc('0', '80', '60') });
    const s = build(ctx, [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)]);
    expect(s.lines).toEqual([`1. Send 50 USDC to Aradhya (${ADDR_ARADHYA}) on Base Sepolia.`]);
  });

  it('C-280 §13.1 i line with depends_on → " After step n." (E3 example lines 2 and 3)', () => {
    const ctx = ctxD({ balances: usdc('0', '30', '50') });
    const j = planJ(ctx, 0, ARB, BASE, '10.2', '10', [1]);
    const a = addAradhya(ctx);
    const mi = addMihir(ctx);
    const plan = [
      j,
      planI(1, mintAmount(ctx, '40'), a, BASE, { depends_on: [0] }),
      planI(2, mintAmount(ctx, '20'), mi, ARB),
    ];
    const s = build(ctx, plan);
    expect(s.lines[1]).toBe(`2. Send 40 USDC to Aradhya (${ADDR_ARADHYA}) on Base Sepolia. After step 1.`);
    expect(s.lines[2]).toBe(`3. Send 20 USDC to Mihir (${ADDR_MIHIR}) on Arbitrum Sepolia.`);
    expect(s.footer).toEqual(['Spent today after this: 60.2 of 300 USDC.']);
  });

  it('C-280 SQ-D-03 §13.1 an i depending on several bridges → "After step 1 and 2."', () => {
    const ctx = ctxD({ balances: usdc('0', '0', '100') });
    const j1 = planJ(ctx, 0, ARB, BASE, '10.2', '10', [2]);
    const j2 = planJ(ctx, 1, SEPOLIA, BASE, '10.2', '10', [2]);
    const a = addAradhya(ctx);
    const i = planI(2, mintAmount(ctx, '20'), a, BASE, { depends_on: [0, 1] });
    expect(build(ctx, [j1, j2, i]).lines[2]).toBe(
      `3. Send 20 USDC to Aradhya (${ADDR_ARADHYA}) on Base Sepolia. After step 1 and 2.`,
    );
  });

  it('C-281 SQ-D-02 §13.1 / E4 group collapses into one line listing every selected member', () => {
    const ctx = ctxD({ balances: usdc('0', '100', '0') });
    const { members } = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [
        { subname: 'alice.iitr.eth', address: ALICE_CS },
        { subname: 'bob.iitr.eth', address: BOB_CS },
      ],
    });
    const a = mintAmount(ctx, '10');
    const plan = [
      planI(0, a, members['alice.iitr.eth'] as AddressPh, BASE),
      planI(1, a, members['bob.iitr.eth'] as AddressPh, BASE),
    ];
    const s = build(ctx, plan);
    expect(s.lines).toEqual([
      '1. Send 10 USDC each to 2 members of iitr.eth on Base Sepolia: alice.iitr.eth, bob.iitr.eth.',
    ]);
    expect(s.text).toBe(
      [
        'Please confirm:',
        '1. Send 10 USDC each to 2 members of iitr.eth on Base Sepolia: alice.iitr.eth, bob.iitr.eth.',
        'Spent today after this: 20 of 300 USDC.',
        'Confirm?',
      ].join('\n'),
    );
  });

  it('C-281 §13.1 a collapsed group followed by another intent keeps the later line number', () => {
    const ctx = ctxD({ balances: usdc('0', '100', '0') });
    const { members } = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [
        { subname: 'alice.iitr.eth', address: ALICE_CS },
        { subname: 'bob.iitr.eth', address: BOB_CS },
      ],
    });
    const a = mintAmount(ctx, '10');
    const plan = [
      planI(0, a, members['alice.iitr.eth'] as AddressPh, BASE),
      planI(1, a, members['bob.iitr.eth'] as AddressPh, BASE),
      planI(2, mintAmount(ctx, '5'), addMihir(ctx), BASE),
    ];
    const s = build(ctx, plan);
    expect(s.lines).toHaveLength(2);
    expect(s.lines[1]).toBe(`2. Send 5 USDC to Mihir (${ADDR_MIHIR}) on Base Sepolia.`);
  });

  it('C-282 E6 §13.1 k line, exact spec text', () => {
    const ctx = ctxD({ actions: ['k'], balances: usdc('0', '100', '0') });
    const mi = addMihir(ctx);
    const s = build(ctx, [planK(ctx, 0, mi, BASE, { amount: '10', total: '80' })]);
    expect(s.lines[0]).toBe(
      `1. Pay Mihir (${ADDR_MIHIR}) 10 USDC every Fri at 10:00 (Asia/Kolkata) on Base Sepolia, first on 6 Nov 2026, until 31 Dec 2026. Sets aside 80 USDC now; anything unused is refunded if you cancel.`,
    );
    // k creation adds 0 to the footer (D-19)
    expect(s.footer).toEqual(['Spent today after this: 0 of 300 USDC.']);
  });

  it('C-282 §13.1 k first date is shown in the schedule timezone, not UTC', () => {
    const line = kLine(weekly(['FRI'], '2026-11-06T10:00:00.000+05:30', E6_END));
    expect(line).toContain('first on 6 Nov 2026');
    const sameInstantUtc = weekly(['FRI'], '2026-11-05T22:00:00.000-06:00', E6_END, {
      tz: 'America/Chicago',
      time: '22:00',
    });
    expect(kLine(sameInstantUtc)).toContain('at 22:00 (America/Chicago)');
    expect(kLine(sameInstantUtc)).toContain('first on 5 Nov 2026');
  });

  it('C-283 E7 §13.1 l line, exact spec text; no footer (nothing moves)', () => {
    const ctx = ctxD({ actions: ['l'] });
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7' });
    const mi = addMihir(ctx);
    const s = build(ctx, [planL(0, mi, 'ap_0000000000f7')]);
    expect(s.lines).toEqual([
      "1. Stop paying Mihir 10 USDC every Fri on Base Sepolia, and refund what's left in it to you.",
    ]);
    expect(s.footer).toEqual([]);
    expect(s.text).toBe(['Please confirm:', s.lines[0], 'Confirm?'].join('\n'));
  });

  it('C-283 §13.1 l line reads the amount and cadence from the DB7 row', () => {
    const ctx = ctxD({ actions: ['l'] });
    addAutopay(ctx, {
      autopay_id: 'ap_0000000000f8',
      amount: '25.50',
      schedule: sched('monthly', '2026-11-15T10:00:00.000+05:30', E6_END, { dom: 15 }),
      chain_id: ARB,
    });
    const s = build(ctx, [planL(0, addMihir(ctx), 'ap_0000000000f8', ARB)]);
    expect(s.lines[0]).toBe(
      "1. Stop paying Mihir 25.5 USDC on the 15th of every month on Arbitrum Sepolia, and refund what's left in it to you.",
    );
  });
});

describe('§13.1 {Name} precedence, address and amount display', () => {
  it('C-284 §13.1 {Name}: contact name wins over the DB3 ENS name', () => {
    const ctx = ctxD();
    const ph = addRecipient(ctx, { name: 'aradhya.eth', ens_name: 'aradhya.eth', address: ARADHYA_CS, source: 'ens' });
    const s = build(ctx, [planI(0, mintAmount(ctx, '5'), ph, BASE)]);
    expect(s.lines[0]).toContain('to Aradhya (');
  });

  it('C-284 §13.1 {Name}: no contact → ENS name', () => {
    const ctx = ctxD();
    const ph = addRecipient(ctx, { name: 'riya', ens_name: 'riya.eth', address: ALICE_CS, source: 'ens' });
    const s = build(ctx, [planI(0, mintAmount(ctx, '5'), ph, BASE)]);
    expect(s.lines[0]).toContain(`to riya.eth (${shortAddress(ALICE_CS)})`);
  });

  it('C-284 §13.1 {Name}: no contact, no ENS → the DB3 name (subname / typed name)', () => {
    const ctx = ctxD();
    const ph = addRecipient(ctx, { name: 'Vendor', address: DOC_ADDR_CS, source: 'untrusted' });
    const s = build(ctx, [planI(0, mintAmount(ctx, '5'), ph, BASE)]);
    expect(s.lines[0]).toContain(`to Vendor (${shortAddress(DOC_ADDR_CS)})`);
  });

  it('C-289 §13.1 address display is 0x+4 hex … last 4 hex of the checksummed address', () => {
    expect(shortAddress(ARADHYA_CS)).toBe('0x3fA9…c21E');
    expect(shortAddress(MIHIR_CS)).toBe('0x91Ab…77d0');
  });

  it('C-289 §13.1 amounts without trailing zeros (USDC and ETH), chain display names from config', () => {
    const ctx = ctxD();
    const a = addAradhya(ctx);
    const usd = planI(0, mintAmount(ctx, '50.500'), a, SEPOLIA);
    const eth = planI(1, mintAmount(ctx, '0.0100', 'ETH'), a, ARB, { token: 'ETH' });
    const s = build(ctx, [usd, eth]);
    expect(s.lines[0]).toBe(`1. Send 50.5 USDC to Aradhya (${ADDR_ARADHYA}) on Sepolia.`);
    expect(s.lines[1]).toBe(`2. Send 0.01 ETH to Aradhya (${ADDR_ARADHYA}) on Arbitrum Sepolia.`);
  });
});

describe('§13.1 {cadence} forms', () => {
  const first = '2026-11-06T10:00:00.000+05:30';
  it('C-285 daily: "every day" / "every {n} days"', () => {
    expect(cadenceText(sched('daily', first, E6_END))).toBe('every day');
    expect(cadenceText(sched('daily', first, E6_END, { interval: 3 }))).toBe('every 3 days');
    expect(kLine(sched('daily', first, E6_END))).toContain('USDC every day at 10:00');
  });

  it('C-285 weekly: "every Mon and Thu" / "every Fri" / "every Mon, Wed and Fri" / "every {n} weeks on Mon"', () => {
    expect(cadenceText(weekly(['MON', 'THU'], first, E6_END))).toBe('every Mon and Thu');
    expect(cadenceText(weekly(['FRI'], first, E6_END))).toBe('every Fri');
    expect(cadenceText(weekly(['MON', 'WED', 'FRI'], first, E6_END))).toBe('every Mon, Wed and Fri');
    expect(cadenceText(weekly(['MON'], first, E6_END, { interval: 2 }))).toBe('every 2 weeks on Mon');
    expect(cadenceText(weekly(['MON', 'THU'], first, E6_END, { interval: 3 }))).toBe('every 3 weeks on Mon and Thu');
  });

  it('C-285 SQ-D-04 monthly: "on the {d}th of every month" with English ordinals / "every {n} months on the {d}th"', () => {
    const m = (dom: number, interval = 1): string => cadenceText(sched('monthly', first, E6_END, { dom, interval }));
    expect(m(1)).toBe('on the 1st of every month');
    expect(m(2)).toBe('on the 2nd of every month');
    expect(m(3)).toBe('on the 3rd of every month');
    expect(m(4)).toBe('on the 4th of every month');
    expect(m(11)).toBe('on the 11th of every month');
    expect(m(12)).toBe('on the 12th of every month');
    expect(m(13)).toBe('on the 13th of every month');
    expect(m(21)).toBe('on the 21st of every month');
    expect(m(22)).toBe('on the 22nd of every month');
    expect(m(23)).toBe('on the 23rd of every month');
    expect(m(28)).toBe('on the 28th of every month');
    expect(m(15, 3)).toBe('every 3 months on the 15th');
  });

  it('C-285 cadence is embedded in the k line between {token} and "at {HH:MM}"', () => {
    const line = kLine(sched('monthly', first, E6_END, { dom: 15, interval: 2 }));
    expect(line).toContain('10 USDC every 2 months on the 15th at 10:00 (Asia/Kolkata)');
  });
});

describe('§13.1 {end text} forms', () => {
  const first = '2026-11-06T10:00:00.000+05:30';
  it('C-286 after_count → "for {n} payments"', () => {
    expect(kLine(weekly(['FRI'], first, { type: 'after_count', count: 8 }))).toContain(
      'first on 6 Nov 2026, for 8 payments. Sets aside',
    );
  });
  it('C-286 SQ-D-11 after_count 1 → "for 1 payments" (template as written)', () => {
    expect(kLine(weekly(['FRI'], first, { type: 'after_count', count: 1 }))).toContain('for 1 payments.');
  });
  it('C-286 on_date → "until {d MMM yyyy}"', () => {
    expect(kLine(weekly(['FRI'], first, { type: 'on_date', date: '2027-01-05' }))).toContain(
      'first on 6 Nov 2026, until 5 Jan 2027. Sets aside',
    );
  });
  it('C-286 until_cancelled → "until you cancel (at most {autopay_max_weeks} weeks)" using DB5', () => {
    expect(kLine(weekly(['FRI'], first, { type: 'until_cancelled' }))).toContain(
      'until you cancel (at most 52 weeks). Sets aside',
    );
    const ctx = ctxD({ actions: ['k'], balances: usdc('0', '1000', '0') });
    setLimits(ctx, { autopay_max_weeks: 26 });
    const line = build(ctx, [
      planK(ctx, 0, addMihir(ctx), BASE, { schedule: weekly(['FRI'], first, { type: 'until_cancelled' }) }),
    ]).lines[0];
    expect(line).toContain('until you cancel (at most 26 weeks)');
  });
});

describe('§13.1 footer and framing', () => {
  it('C-287 footer: one line per token used, USDC then ETH, spent_today + this_request of daily_max', () => {
    const ctx = ctxD({ balances: usdc('0', '500', '0') });
    ctx.repos.db6.insertMany([
      db6Row({ kind: 'payment', amount: '100', status: 'pending', created_at: '2026-11-05T10:00:00.000Z' }),
      db6Row({
        kind: 'payment',
        amount: '0.02',
        token: 'ETH',
        status: 'pending',
        created_at: '2026-11-05T10:00:00.000Z',
      }),
    ]);
    const a = addAradhya(ctx);
    const plan = [
      planI(0, mintAmount(ctx, '50'), a, BASE),
      planI(1, mintAmount(ctx, '0.01', 'ETH'), a, BASE, { token: 'ETH' }),
    ];
    expect(build(ctx, plan).footer).toEqual([
      'Spent today after this: 150 of 300 USDC.',
      'Spent today after this: 0.03 of 0.15 ETH.',
    ]);
  });

  it('C-287 footer: a single token produces a single line; yesterday-local rows are excluded', () => {
    const ctx = ctxD({ balances: usdc('0', '500', '0') });
    ctx.repos.db6.insertMany([
      db6Row({ kind: 'payment', amount: '200', status: 'pending', created_at: '2026-11-04T18:29:59.000Z' }),
    ]);
    const s = build(ctx, [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)]);
    expect(s.footer).toEqual(['Spent today after this: 50 of 300 USDC.']);
  });

  it('C-287 footer counts a j buffer but not its deliverable (E2: 50 + 0.4 = 50.4)', () => {
    const ctx = ctxD({ balances: usdc('0', '30', '60') });
    const j = planJ(ctx, 0, ARB, BASE, '20.4', '20', [1]);
    const i = planI(1, mintAmount(ctx, '50'), addAradhya(ctx), BASE, { depends_on: [0] });
    expect(build(ctx, [j, i]).footer).toEqual(['Spent today after this: 50.4 of 300 USDC.']);
  });

  it('C-288 §13.1 framing: "Please confirm:" first, numbered lines, notes as bullets, footer, "Confirm?" last', () => {
    const ctx = ctxD({ balances: usdc('0', '80', '60') });
    ctx.req.notes.push('Recipient and chain from your last payment.');
    const s = build(ctx, [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)]);
    expect(s.text.split('\n')).toEqual([
      'Please confirm:',
      `1. Send 50 USDC to Aradhya (${ADDR_ARADHYA}) on Base Sepolia.`,
      '- Recipient and chain from your last payment.',
      'Spent today after this: 50 of 300 USDC.',
      'Confirm?',
    ]);
    expect(s.notes).toEqual(['Recipient and chain from your last payment.']);
  });

  it('C-288 §13.1 the full spec example (E3) renders character for character', () => {
    const ctx = ctxD({ balances: usdc('0', '30', '50') });
    const j = planJ(ctx, 0, ARB, BASE, '10.2', '10', [1]);
    const plan = [
      j,
      planI(1, mintAmount(ctx, '40'), addAradhya(ctx), BASE, { depends_on: [0] }),
      planI(2, mintAmount(ctx, '20'), addMihir(ctx), ARB),
    ];
    expect(build(ctx, plan).text).toBe(
      [
        'Please confirm:',
        '1. Move 10.2 USDC from Arbitrum Sepolia to Base Sepolia (your own account; includes a 2% fee buffer, anything left over stays with you).',
        '2. Send 40 USDC to Aradhya (0x3fA9…c21E) on Base Sepolia. After step 1.',
        '3. Send 20 USDC to Mihir (0x91Ab…77d0) on Arbitrum Sepolia.',
        'Spent today after this: 60.2 of 300 USDC.',
        'Confirm?',
      ].join('\n'),
    );
  });
});

describe('§13.1 notes', () => {
  it('C-290 §13.1 note "Same address as on {Chain}." is emitted by S9 and appears in the summary', async () => {
    // Aradhya has Base + Arbitrum rows; paying on Sepolia reuses the address silently.
    const ctx = ctxD({ balances: usdc('100', '0', '0') });
    const r = addAradhya(ctx);
    const res = await run(ctx, [iPay(ctx, '5', r, SEPOLIA)]);
    expect(res).toEqual({ kind: 'continue' });
    const s = buildSummary(ctx, ctx.req.plan as InternalIntent[]);
    expect(s.notes.some((n) => /^Same address as on (Base|Arbitrum) Sepolia\.$/.test(n))).toBe(true);
    expect(s.text).toMatch(/\n- Same address as on (Base|Arbitrum) Sepolia\.\n/);
  });

  it('C-291 §13.1 note "Recipient and chain from your last payment." (follow-up) appears in the summary', () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    ctx.req.notes.push(NOTES.FOLLOWUP());
    const s = build(ctx, [planI(0, mintAmount(ctx, '5'), addAradhya(ctx), BASE)]);
    expect(s.notes).toEqual(['Recipient and chain from your last payment.']);
  });

  it('C-296 §13.1 note "Paid on the 28th, since months differ in length." is emitted by S9 for a day-29/30/31 monthly k', async () => {
    const { ctx, payment } = kSetup({
      clause: 'pay mihir 10 usdc on the 31st of every month for 3 months',
      day_of_month: 31,
      frequency: 'monthly',
      days_of_week: null,
      balances: usdc('0', '1000', '0'),
    });
    ctx.req.scan.recurrence = [];
    const res = await run(ctx, [payment]);
    expect(res.kind).toBe('continue');
    const s = buildSummary(ctx, ctx.req.plan as InternalIntent[]);
    expect(s.notes).toContain('Paid on the 28th, since months differ in length.');
    expect(s.lines[0]).toContain('on the 28th of every month');
  });

  it('C-292 §13.1 note "You wrote \'{phrase}\' → {amount} {token}." for an LLM-only number', () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    const a = addAmount(ctx, '50', { phrase: 'fifty', code_verified: false });
    const s = build(ctx, [planI(0, a, addAradhya(ctx), BASE)]);
    expect(s.notes).toEqual(["You wrote 'fifty' → 50 USDC."]);
  });

  it('C-292 §13.1 note "You wrote …" for a relative amount (half) and for fiat USD', () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    const half = addAmount(ctx, '40', { phrase: 'half', relative: 'half', pinned_chain_id: BASE });
    const usd = addAmount(ctx, '25', { phrase: '$25', fiat: 'USD' });
    const a = addAradhya(ctx);
    const s = build(ctx, [planI(0, half, a, BASE), planI(1, usd, a, BASE)]);
    expect(s.notes).toEqual(["You wrote 'half' → 40 USDC.", "You wrote '$25' → 25 USDC."]);
  });

  it('C-292 §13.1 no "You wrote" note for a code-verified typed amount', () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    const a = addAmount(ctx, '50');
    expect(build(ctx, [planI(0, a, addAradhya(ctx), BASE)]).notes).toEqual([]);
  });

  it('C-293 SQ-D-10 §13.1 note "From attached content: {what}. You confirmed it." for a payment with an untrusted amount and address: one note worded as §19 E9 (SQ-D-10)', () => {
    const ctx = ctxD({ balances: usdc('0', '500', '0') });
    setLimits(ctx, { per_tx_max: { USDC: '200', ETH: '0.05' } });
    const a = addAmount(ctx, '120', { source: 'untrusted', confirmed: true });
    const doc = addRecipient(ctx, { name: 'Vendor', address: DOC_ADDR_CS, source: 'untrusted' });
    const s = build(ctx, [planI(0, a, doc, BASE)]);
    expect(s.notes).toEqual([`From attached content: 120 USDC to ${shortAddress(DOC_ADDR_CS)}. You confirmed it.`]);
  });

  it('C-298 §13.1 note "Today\'s limit was lifted once for this group payment." passes through from req.notes', () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    ctx.req.notes.push(NOTES.LIMIT_LIFTED());
    const s = build(ctx, [planI(0, mintAmount(ctx, '5'), addAradhya(ctx), BASE)]);
    expect(s.text).toContain("\n- Today's limit was lifted once for this group payment.\n");
  });

  it('C-297 §13.1 notes from earlier steps keep their order and are bulleted with "- "', () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    ctx.req.notes.push(
      'Skipped carol.iitr.eth: no address on Base Sepolia.',
      "Today's limit was lifted once for this group payment.",
    );
    const s = build(ctx, [planI(0, mintAmount(ctx, '5'), addAradhya(ctx), BASE)]);
    expect(s.text.split('\n').filter((l) => l.startsWith('- '))).toEqual([
      '- Skipped carol.iitr.eth: no address on Base Sepolia.',
      "- Today's limit was lifted once for this group payment.",
    ]);
  });
});

describe('S11 step (§8.13)', () => {
  it('C-149 §8.13 S11 builds the summary from real values, stores it, state AWAITING_CONFIRMATION, returns summary', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '60') });
    ctx.req.plan = [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)];
    const res = await s11.step(ctx);
    expect(res.kind).toBe('summary');
    if (res.kind !== 'summary') return;
    expect(res.summary).toBe(ctx.req.summary);
    expect(res.summary.lines).toEqual([`1. Send 50 USDC to Aradhya (${ADDR_ARADHYA}) on Base Sepolia.`]);
    expect(res.summary.footer).toEqual(['Spent today after this: 50 of 300 USDC.']);
    expect(ctx.req.state).toBe('AWAITING_CONFIRMATION');
    expect(ctx.req.prepend_messages).toEqual([]);
  });

  it('C-149 §8.13 summary text never contains the DB3 placeholder or the full address', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '60') });
    const ph = addAradhya(ctx);
    ctx.req.plan = [planI(0, mintAmount(ctx, '50'), ph, BASE)];
    const res = await s11.step(ctx);
    expect(res.kind === 'summary' && res.summary.text).toBeTruthy();
    const text = res.kind === 'summary' ? res.summary.text : '';
    expect(text).not.toContain(ph);
    expect(text).not.toContain(ARADHYA_CS);
    expect(text).not.toMatch(/amount_[0-9a-f]+/);
  });

  it('S11 without a plan → INTERNAL_ERROR (rule S11_NO_PLAN logged)', async () => {
    const ctx = ctxD();
    const res = await s11.step(ctx);
    expect(res).toEqual({ kind: 'error', code: 'INTERNAL_ERROR' });
    expect(ctx.log.lines.some((l) => l.rule_id === 'S11_NO_PLAN')).toBe(true);
  });

  it('S11 whose summary cannot be built (missing DB3 row) → INTERNAL_ERROR (rule S11_BUILD logged)', async () => {
    const ctx = ctxD();
    ctx.req.plan = [planI(0, mintAmount(ctx, '5'), 'address_deadbeef' as AddressPh, BASE)];
    const res = await s11.step(ctx);
    expect(res).toEqual({ kind: 'error', code: 'INTERNAL_ERROR' });
    expect(ctx.log.lines.some((l) => l.rule_id === 'S11_BUILD')).toBe(true);
    expect(ctx.req.state).not.toBe('AWAITING_CONFIRMATION');
  });

  it('SQB-15 §8.5 rule 3: with also_balance the balance answer is the FIRST message of the summary response', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '60') });
    ctx.req.also_balance = true;
    ctx.req.prepend_messages = [REPLY.PENDING_REPLACED()];
    ctx.req.plan = [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)];
    const res = await s11.step(ctx);
    expect(res.kind).toBe('summary');
    expect(ctx.req.prepend_messages).toEqual([...buildBalanceAnswer(ctx), REPLY.PENDING_REPLACED()]);
    expect(ctx.req.prepend_messages[0]?.startsWith('Your balances:')).toBe(true);
  });

  it('SQB-15 without also_balance nothing is prepended', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '60') });
    ctx.req.plan = [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)];
    await s11.step(ctx);
    expect(ctx.req.prepend_messages).toEqual([]);
  });
});

describe('§13.2 balance answer (C-301)', () => {
  it('C-301 §13.2 the spec example, character for character (unavailable chain, totals of readable chains)', () => {
    const ctx = ctxD({
      balances: {
        [SEPOLIA]: { ETH: '0.42', USDC: '12.5' },
        [BASE]: { ETH: '0.05', USDC: '30' },
      },
    });
    ctx.repos.db4.markUnavailable(ARB, 'Arbitrum Sepolia', '2026-11-05T17:29:00Z');
    ctx.repos.db4.markUnavailable(ARB, 'Arbitrum Sepolia', '2026-11-05T17:29:00Z');
    expect(buildBalanceAnswer(ctx)).toEqual([
      [
        'Your balances:',
        '- Sepolia: 0.42 ETH (0.41 spendable after the gas reserve), 12.5 USDC',
        '- Base Sepolia: 0.05 ETH (0.048 spendable), 30 USDC',
        "- Arbitrum Sepolia: couldn't be read right now",
        'Total: 0.47 ETH, 42.5 USDC',
      ].join('\n'),
    ]);
  });

  it('C-301 §13.2 every allowed chain is listed in allowed_chain_ids order; a chain not allowed is omitted', () => {
    const ctx = ctxD({ balances: usdc('1', '2', '3') });
    setLimits(ctx, { allowed_chain_ids: [ARB, SEPOLIA] });
    const [msg] = buildBalanceAnswer(ctx);
    const lines = (msg as string).split('\n');
    expect(lines[0]).toBe('Your balances:');
    expect(lines[1]).toMatch(/^- Arbitrum Sepolia: 0\.1 ETH \(0\.098 spendable after the gas reserve\), 3 USDC$/);
    expect(lines[2]).toMatch(/^- Sepolia: 0\.1 ETH \(0\.09 spendable\), 1 USDC$/);
    expect(lines[3]).toBe('Total: 0.2 ETH, 4 USDC');
    expect(lines).toHaveLength(4);
  });

  it('C-301 §13.2 raw ETH minus pending DB6 rows and reserve is shown as spendable; floors at 0', () => {
    const ctx = ctxD({ balances: { [BASE]: { ETH: '0.003', USDC: '0' } } });
    const [msg] = buildBalanceAnswer(ctx);
    expect(msg).toContain('- Base Sepolia: 0.003 ETH (0.001 spendable), 0 USDC');
    ctx.repos.db6.insertMany([
      db6Row({ kind: 'payment', amount: '0.003', token: 'ETH', created_at: '2026-11-05T17:25:00.000Z' }),
    ]);
    expect(buildBalanceAnswer(ctx)[0]).toContain('- Base Sepolia: 0.003 ETH (0 spendable), 0 USDC');
  });
});

describe('§13.3 fixed replies (C-302)', () => {
  it('C-302 §13.3 fixed reply texts verbatim', () => {
    expect(REPLY.HANDED_OFF()).toBe('Sent to your wallet for signing.');
    expect(REPLY.USER_SAID_NO()).toBe("OK, I've dropped that. Tell me what you'd like instead.");
    expect(REPLY.CANCELLED()).toBe('Cancelled. Nothing was sent.');
    expect(REPLY.PENDING_REPLACED()).toBe('I dropped the previous plan and started on your new request.');
  });
});

// keep helper imports referenced for lint
void [addChrono, pay, setClauses];
