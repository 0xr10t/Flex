// Lane D tester: §19 worked examples E1–E9 end to end through S8 → S9 → S10 → S11 → S12 with fixture LLM #4 output.
// Asserts the S8 payments, the plan, the exact summary text and the hand-off / DB6 / DB7 / DB8 effects after confirmation.
import { describe, expect, it, vi } from 'vitest';
import type {
  AddressPh,
  AmountPh,
  Answer,
  InternalIntent,
  Payment,
  PlanI,
  PlanJ,
} from '../../../src/contracts/types.js';
import type { StepResult } from '../../../src/contracts/step.js';
import { s10 } from '../../../src/pipeline/s10-validate.js';
import { s11 } from '../../../src/pipeline/s11-summary.js';
import { s12 } from '../../../src/pipeline/s12-handoff.js';
import { s8 } from '../../../src/pipeline/s8-pair.js';
import { s9 } from '../../../src/pipeline/s9-plan.js';
import { FixtureLlmClient, type FixtureCall } from '../../fakes/llm.js';
import type { TestContext } from '../../fakes/context.js';
import { seedBalances } from '../../fakes/repos.js';
import {
  ALICE_CS,
  ARADHYA_CS,
  ARB,
  BASE,
  BOB_CS,
  DOC_ADDR_CS,
  MIHIR_CS,
  USDC_ADDR,
  WALLET_CS,
  addAmount,
  addAradhya,
  addAutopay,
  addChainMention,
  addFollowup,
  addGroup,
  addMihir,
  addRecipient,
  addWord,
  ctxD,
  db6Row,
  expectError,
  expectQuestion,
  llmItem,
  paymentsCall,
  setClauses,
  setLimits,
} from './helpers.js';
import { chip, kSetup, usdc } from './s9-helpers.js';

vi.mock('../../../src/amounts/parse.js', async () => {
  const m = await import('./parse-mock.js');
  return { parseAmountText: (t: string) => m.fakeParseAmountText(t) };
});

const A_ARADHYA = '0x3fA9…c21E';
// §19 prints Mihir as 0x91aB…77d0, which is not a valid EIP-55 checksum; the code displays the real checksum.
const A_MIHIR = '0x91Ab…77d0';

function useFixture(ctx: TestContext, calls: FixtureCall[]): FixtureLlmClient {
  const llm = new FixtureLlmClient({ calls });
  ctx.llm = llm;
  return llm;
}

interface Run {
  s8: StepResult;
  s9?: StepResult;
  s10?: StepResult;
  s11?: StepResult;
}

/** S8 → S9 → S10 → S11 (stops at the first non-continue result). */
async function toSummary(ctx: TestContext): Promise<Run> {
  const out: Run = { s8: await s8.step(ctx) };
  if (out.s8.kind !== 'continue') return out;
  out.s9 = await s9.step(ctx);
  if (out.s9.kind !== 'continue') return out;
  out.s10 = await s10.step(ctx);
  if (out.s10.kind !== 'continue') return out;
  out.s11 = await s11.step(ctx);
  return out;
}

function summaryText(r: Run): string {
  expect(r.s11?.kind).toBe('summary');
  return r.s11?.kind === 'summary' ? r.s11.summary.text : '';
}

const plan = (ctx: TestContext): InternalIntent[] => ctx.req.plan as InternalIntent[];

describe('§19 worked examples end to end', () => {
  it('C-432 A-01 E1: "Send 50 USDc to ARADHYA" (Base 80 / Arbitrum 60) → i on Base; summary; hand-off envelope; DB6/DB8', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '60') });
    ctx.req.request_id = 'req_5d1c0a9b8e7f' as never;
    const a = addAmount(ctx, '50', { phrase: '50 USDc' });
    const r = addAradhya(ctx);
    ctx.req.masked_text_s8 = `Send ${a} to ${r}`;
    useFixture(ctx, [paymentsCall(a, [llmItem('i', a, r)])]);
    const run = await toSummary(ctx);
    expect(ctx.req.payments).toEqual([{ ...llmItem('i', a, r), token: 'USDC' }]);
    expect(plan(ctx)).toEqual([
      {
        intent_id: 'i',
        step: 0,
        depends_on: [],
        token: 'USDC',
        chain_id: BASE,
        amount: a,
        recipient: r,
        reused_from_chain_id: null,
      },
    ]);
    expect(summaryText(run)).toBe(
      [
        'Please confirm:',
        `1. Send 50 USDC to Aradhya (${A_ARADHYA}) on Base Sepolia.`,
        'Spent today after this: 50 of 300 USDC.',
        'Confirm?',
      ].join('\n'),
    );
    expect(ctx.req.state).toBe('AWAITING_CONFIRMATION');
    const h = await s12.step(ctx);
    expect(h).toEqual({ kind: 'answer', messages: ['Sent to your wallet for signing.'] });
    expect(ctx.exec.submissions[0]?.envelope).toEqual({
      version: '1',
      request_id: 'req_5d1c0a9b8e7f',
      wallet_address: WALLET_CS,
      created_at: '2026-11-05T17:30:00Z',
      intents: [
        {
          intent_id: 'i',
          step: 0,
          depends_on: [],
          token: 'USDC',
          token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          chain_id: 84532,
          amount: { value: '50', base_units: '50000000', decimals: 6 },
          // §19 prints 0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E, not a valid EIP-55 checksum; the envelope carries the real one.
          recipient: ARADHYA_CS,
        },
      ],
    });
    expect(ctx.exec.submissions[0]?.idempotencyKey).toBe('req_5d1c0a9b8e7f');
    expect(ctx.repos.tables.db6.map((x) => [x.kind, x.amount, x.counts_toward_limit])).toEqual([
      ['payment', '50', true],
    ]);
    expect(ctx.req.state).toBe('HANDED_OFF');
    const hist = JSON.parse(ctx.repos.tables.db8_history[0]?.payments_json ?? '[]') as unknown[];
    expect(hist).toEqual([{ ...llmItem('i', a, r), token: 'USDC', chain_id: BASE }]);
  });

  it('C-433 A-02 E2: "Send 50 usdc to ARADHYA on base" (Base 30 / Arbitrum 60) → [j 20.4, i 50]; counted 50.4; DB6 bridge rows', async () => {
    const ctx = ctxD({ balances: usdc('0', '30', '60') });
    const a = addAmount(ctx, '50');
    const r = addAradhya(ctx);
    addChainMention(ctx, 'base', BASE);
    ctx.req.masked_text_s8 = `Send ${a} to ${r} on base`;
    useFixture(ctx, [paymentsCall(a, [llmItem('i', a, r, BASE)])]);
    const run = await toSummary(ctx);
    const p = plan(ctx);
    expect(p).toHaveLength(2);
    const j = p[0] as PlanJ;
    expect(j).toMatchObject({
      intent_id: 'j',
      source_chain_id: ARB,
      dest_chain_id: BASE,
      deliverable_base_units: '20000000',
      funds_steps: [1],
    });
    expect(p[1]).toMatchObject({ intent_id: 'i', step: 1, depends_on: [0], chain_id: BASE, amount: a, recipient: r });
    expect(summaryText(run)).toBe(
      [
        'Please confirm:',
        '1. Move 20.4 USDC from Arbitrum Sepolia to Base Sepolia (your own account; includes a 2% fee buffer, anything left over stays with you).',
        `2. Send 50 USDC to Aradhya (${A_ARADHYA}) on Base Sepolia. After step 1.`,
        'Spent today after this: 50.4 of 300 USDC.',
        'Confirm?',
      ].join('\n'),
    );
    await s12.step(ctx);
    const env = ctx.exec.submissions[0]?.envelope;
    expect(env?.intents.map((x) => x.intent_id)).toEqual(['j', 'i']);
    expect(env?.intents[0]).toMatchObject({
      amount: { value: '20.4', base_units: '20400000', decimals: 6 },
      source_token_address: USDC_ADDR[ARB],
      dest_token_address: USDC_ADDR[BASE],
      funds_steps: [1],
    });
    expect(env?.intents[1]).toMatchObject({
      depends_on: [0],
      amount: { value: '50', base_units: '50000000', decimals: 6 },
    });
    expect(ctx.repos.tables.db6.map((x) => [x.step, x.kind, x.amount, x.counts_toward_limit, x.chain_id])).toEqual([
      [0, 'bridge_out', '20.4', false, ARB],
      [0, 'bridge_buffer', '0.4', true, ARB],
      [1, 'payment', '50', true, BASE],
    ]);
    expect(
      ctx.repos.db6
        .spentToday('USDC', 'Asia/Kolkata', '2026-11-05T17:31:00.000Z')
        .reduce((s, x) => s + Number(x.amount), 0),
    ).toBeCloseTo(50.4, 6);
  });

  it('C-434 A-03 E3: 40 to Aradhya on base and 20 to Mihir on arbitrum (Arbitrum 50 / Base 30) → [j 10.2, i 40, i 20], spec summary', async () => {
    const ctx = ctxD({ balances: usdc('0', '30', '50') });
    setClauses(ctx, ['Send 40 usdc to ARADHYA on base', 'and 20 usdc to mihir on arbitrum']);
    const a1 = addAmount(ctx, '40', { clause: 0 });
    const r1 = addAradhya(ctx, 0);
    const a2 = addAmount(ctx, '20', { clause: 1 });
    const r2 = addMihir(ctx, 1);
    addChainMention(ctx, 'base', BASE, 0);
    addChainMention(ctx, 'arbitrum', ARB, 1);
    ctx.req.masked_text_s8 = `Send ${a1} to ${r1} on base, and ${a2} to ${r2} on arbitrum`;
    useFixture(ctx, [paymentsCall(a1, [llmItem('i', a1, r1, BASE), llmItem('i', a2, r2, ARB)])]);
    const run = await toSummary(ctx);
    expect((plan(ctx)[0] as PlanJ).deliverable_base_units).toBe('10000000');
    expect(plan(ctx).map((x) => x.intent_id)).toEqual(['j', 'i', 'i']);
    expect(summaryText(run)).toBe(
      [
        'Please confirm:',
        '1. Move 10.2 USDC from Arbitrum Sepolia to Base Sepolia (your own account; includes a 2% fee buffer, anything left over stays with you).',
        `2. Send 40 USDC to Aradhya (${A_ARADHYA}) on Base Sepolia. After step 1.`,
        `3. Send 20 USDC to Mihir (${A_MIHIR}) on Arbitrum Sepolia.`,
        'Spent today after this: 60.2 of 300 USDC.',
        'Confirm?',
      ].join('\n'),
    );
    await s12.step(ctx);
    const counted = ctx.repos.tables.db6.filter((x) => x.counts_toward_limit).map((x) => x.amount);
    expect(counted).toEqual(['0.2', '40', '20']);
    const hist = JSON.parse(ctx.repos.tables.db8_history[0]?.payments_json ?? '[]') as Array<{ chain_id: number }>;
    expect(hist.map((x) => x.chain_id)).toEqual([BASE, ARB]);
  });

  function e4(): { ctx: TestContext; a: AmountPh; g: string } {
    const ctx = ctxD({ balances: usdc('0', '500', '0') });
    setClauses(ctx, ['Send 10 usdc to everyone on the list with @iitr.ac.in subdomain']);
    const a = addAmount(ctx, '10');
    const { group } = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [
        { subname: 'bob.iitr.eth', address: BOB_CS },
        { subname: 'alice.iitr.eth', address: ALICE_CS },
      ],
    });
    ctx.req.notes.push('Skipped carol.iitr.eth: no address on Base Sepolia.');
    ctx.req.masked_text_s8 = `Send ${a} to everyone on ${group}`;
    addWord(ctx, 'distributive', 'everyone');
    addChainMention(ctx, 'base', BASE);
    useFixture(ctx, [paymentsCall(a, [llmItem('i', a, group, BASE)])]);
    return { ctx, a, g: group };
  }

  it('C-435 A-04 E4: group of two on Base → collapsed summary line + skipped note; two payment rows in subname order', async () => {
    const { ctx } = e4();
    const run = await toSummary(ctx);
    expect(summaryText(run)).toBe(
      [
        'Please confirm:',
        '1. Send 10 USDC each to 2 members of iitr.eth on Base Sepolia: alice.iitr.eth, bob.iitr.eth.',
        '- Skipped carol.iitr.eth: no address on Base Sepolia.',
        'Spent today after this: 20 of 300 USDC.',
        'Confirm?',
      ].join('\n'),
    );
    await s12.step(ctx);
    const env = ctx.exec.submissions[0]?.envelope;
    expect(env?.intents.map((x) => (x.intent_id === 'i' ? x.recipient : null))).toEqual([ALICE_CS, BOB_CS]);
    expect(JSON.stringify(env)).not.toContain('iitr');
    expect(ctx.repos.tables.db6.map((x) => [x.kind, x.amount, x.recipient_address])).toEqual([
      ['payment', '10', ALICE_CS],
      ['payment', '10', BOB_CS],
    ]);
    const hist = JSON.parse(ctx.repos.tables.db8_history[0]?.payments_json ?? '[]') as Array<{
      recipient: string;
      chain_id: number;
    }>;
    expect(hist).toHaveLength(1);
    expect(hist[0]?.recipient).toMatch(/^group_/);
    expect(hist[0]?.chain_id).toBe(BASE);
  });

  it('C-435 C-326 C-298 E4 "If today\'s spend were 290 of 300 → Q_GROUP_OVER_LIMIT before the summary"; yes → lifted note + footer 310 of 300', async () => {
    const { ctx } = e4();
    ctx.repos.db6.insertMany([db6Row({ kind: 'payment', amount: '290', created_at: '2026-11-05T10:00:00.000Z' })]);
    const first = await toSummary(ctx);
    expect(first.s10?.kind).toBe('question');
    expect(first.s11).toBeUndefined();
    const q = expectQuestion(first.s10 as StepResult, 'Q_LIMIT_OVERRIDE');
    expect(q.text).toBe("This sends 20 USDC, but only 10 is left of today's 300 limit. Go ahead this once?");
    expect(await s10.onAnswer?.(ctx, q, chip('override'))).toEqual({ kind: 'continue' });
    expect(await s10.step(ctx)).toEqual({ kind: 'continue' });
    const sum = await s11.step(ctx);
    expect(sum.kind).toBe('summary');
    const text = sum.kind === 'summary' ? sum.summary.text : '';
    expect(text).toContain("- Today's limit was lifted once for this group payment.");
    expect(text).toContain('Spent today after this: 310 of 300 USDC.');
    await s12.step(ctx);
    expect(ctx.req.state).toBe('HANDED_OFF');
  });

  it('C-436 E5: E2 then "Send 5 more" → i of 5 to Aradhya on 84532 with the follow-up note; footer carries the earlier spend', async () => {
    // Request 1 = E2.
    const ctx1 = ctxD({ balances: usdc('0', '30', '60') });
    const a = addAmount(ctx1, '50');
    const r = addAradhya(ctx1);
    addChainMention(ctx1, 'base', BASE);
    ctx1.req.masked_text_s8 = `Send ${a} to ${r} on base`;
    useFixture(ctx1, [paymentsCall(a, [llmItem('i', a, r, BASE)])]);
    await toSummary(ctx1);
    await s12.step(ctx1);
    expect(ctx1.req.state).toBe('HANDED_OFF');

    // Request 2 in the same session and repositories; balances were refreshed by the poller.
    const ctx2 = ctxD({ balances: usdc('0', '85', '40') });
    ctx2.repos = ctx1.repos;
    ctx2.limits = ctx1.limits;
    seedBalances(ctx2.repos, { [BASE]: { ETH: '0.1', USDC: '85' }, [ARB]: { ETH: '0.1', USDC: '40' } });
    ctx2.req.request_id = 'req_000000000002' as never;
    const a5 = addAmount(ctx2, '5');
    const prev = addFollowup(ctx2, { name: 'Aradhya', address: ARADHYA_CS, last_chain_id: BASE });
    ctx2.req.masked_text_s8 = `Send ${a5} more to ${prev}`;
    useFixture(ctx2, [paymentsCall(a5, [llmItem('i', a5, prev, 'unstated')])]);
    const run = await toSummary(ctx2);
    expect(plan(ctx2)).toEqual([
      {
        intent_id: 'i',
        step: 0,
        depends_on: [],
        token: 'USDC',
        chain_id: BASE,
        amount: a5,
        recipient: prev,
        reused_from_chain_id: null,
      },
    ]);
    expect(summaryText(run)).toBe(
      [
        'Please confirm:',
        `1. Send 5 USDC to Aradhya (${A_ARADHYA}) on Base Sepolia.`,
        '- Recipient and chain from your last payment.',
        'Spent today after this: 55.4 of 300 USDC.',
        'Confirm?',
      ].join('\n'),
    );
    await s12.step(ctx2);
    expect(ctx2.repos.db8.recentHistory(ctx2.req.session_id, 5).map((h) => h.request_id)).toEqual([
      'req_000000000002',
      ctx1.req.request_id,
    ]);
  });

  function e6(): { ctx: TestContext; payment: Payment; mi: AddressPh } {
    const { ctx, payment, recipient } = kSetup({
      clause: 'pay mihir 10 usdc every friday for 8 weeks',
      balances: usdc('0', '100', '90'),
    });
    return { ctx, payment, mi: recipient };
  }

  it('C-437 E6: "pay mihir 10 usdc every friday for 8 weeks" → k on Base; spec summary; prefund 80 not counted; DB7 pending (expires_at follows the §10.6 rule: last occurrence 2026-12-25, §19 text says 12-31)', async () => {
    const { ctx, payment, mi } = e6();
    ctx.req.masked_text_s8 = `pay ${mi} ${payment.amount} every friday for 8 weeks`;
    useFixture(ctx, [
      paymentsCall(String(payment.amount), [
        llmItem('k', payment.amount, mi, 'unstated', { frequency: 'weekly', interval: 1, days_of_week: ['FRI'] }),
      ]),
    ]);
    ctx.req.scan.recurrence.push({ word: 'every', text: 'every', start: 0, end: 5, clause_index: 0 } as never);
    const run = await toSummary(ctx);
    expect(run.s8.kind).toBe('continue');
    expect(run.s11?.kind).toBe('summary');
    expect(summaryText(run)).toBe(
      [
        'Please confirm:',
        `1. Pay Mihir (${A_MIHIR}) 10 USDC every Fri at 10:00 (Asia/Kolkata) on Base Sepolia, first on 6 Nov 2026, until 31 Dec 2026. Sets aside 80 USDC now; anything unused is refunded if you cancel.`,
        'Spent today after this: 0 of 300 USDC.',
        'Confirm?',
      ].join('\n'),
    );
    await s12.step(ctx);
    const k = ctx.exec.submissions[0]?.envelope.intents[0];
    expect(k).toMatchObject({
      intent_id: 'k',
      token_address: USDC_ADDR[BASE],
      chain_id: BASE,
      recipient: MIHIR_CS,
      amount_per_payment: { value: '10', base_units: '10000000', decimals: 6 },
      prefund: { value: '80', base_units: '80000000', decimals: 6 },
      limits: {
        per_period_cap: { value: '10', base_units: '10000000', decimals: 6 },
        total_cap: { value: '80', base_units: '80000000', decimals: 6 },
        expires_at: '2026-12-25T18:29:59Z',
      },
      cre_job: { trigger: 'cron', cron: '0 10 * * 5', timezone: 'Asia/Kolkata', interval: 1 },
    });
    expect(ctx.repos.tables.db6.map((x) => [x.kind, x.amount, x.counts_toward_limit])).toEqual([
      ['autopay_prefund', '80', false],
    ]);
    const rows = ctx.repos.db7.listByRequest(ctx.req.request_id);
    expect(rows.map((x) => x.status)).toEqual(['pending']);
    expect(rows[0]).toMatchObject({ recipient_name: 'Mihir', amount_per_payment: '10', chain_id: BASE });
  });

  it('C-438 E7: "stop paying mihir" → l with the DB7 autopay; spec summary line; no footer; no DB6 rows', async () => {
    const ctx = ctxD({ actions: ['l'], balances: usdc('0', '10', '10') });
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7' });
    setClauses(ctx, ['stop paying mihir']);
    const mi = addMihir(ctx);
    ctx.req.masked_text_s8 = `stop paying ${mi}`;
    useFixture(ctx, [paymentsCall(mi, [llmItem('l', null, mi)])]);
    const run = await toSummary(ctx);
    expect(ctx.req.payments).toEqual([{ ...llmItem('l', null, mi), token: null }]);
    expect(plan(ctx)).toMatchObject([{ intent_id: 'l', autopay_id: 'ap_0000000000f7', chain_id: BASE }]);
    expect(summaryText(run)).toBe(
      [
        'Please confirm:',
        "1. Stop paying Mihir 10 USDC every Fri on Base Sepolia, and refund what's left in it to you.",
        'Confirm?',
      ].join('\n'),
    );
    await s12.step(ctx);
    expect(ctx.exec.submissions[0]?.envelope.intents).toEqual([
      expect.objectContaining({
        intent_id: 'l',
        autopay_id: 'ap_0000000000f7',
        chain_id: BASE,
        recipient: MIHIR_CS,
        refund_remaining: true,
      }),
    ]);
    expect(ctx.repos.tables.db6).toEqual([]);
  });

  it('C-439 E8: story context → hand-off contains only the 50 USDC transfer to Aradhya (no 500, no Kabir, no free text)', async () => {
    const ctx = ctxD({ balances: usdc('0', '100', '0') });
    setClauses(ctx, ['Pay Aradhya 50 usdc for the design work she did for my friend Kabir, she charged 500 last time']);
    const a = addAmount(ctx, '50');
    const r = addAradhya(ctx);
    ctx.req.masked_text_s8 = `Pay ${r} ${a} for the design work she did for my friend [person], she charged [amount] last time`;
    useFixture(ctx, [paymentsCall(a, [llmItem('i', a, r)])]);
    const run = await toSummary(ctx);
    expect(summaryText(run)).toContain(`1. Send 50 USDC to Aradhya (${A_ARADHYA}) on Base Sepolia.`);
    await s12.step(ctx);
    const body = JSON.stringify(ctx.exec.submissions[0]?.envelope);
    expect(ctx.exec.submissions[0]?.envelope.intents).toHaveLength(1);
    for (const f of ['Kabir', 'design', 'charged', 'Aradhya', '"500"', '500000000']) expect(body).not.toContain(f);
  });

  function e9(): { ctx: TestContext } {
    const ctx = ctxD({ balances: usdc('0', '500', '0'), contacts: false });
    ctx.req.untrusted = [{ item_index: 0, address: DOC_ADDR_CS, ens_name: null, amount: '120', token: 'USDC' }];
    const a = addAmount(ctx, '120', { source: 'untrusted', confirmed: true, untrusted_item_index: 0 });
    const r = addRecipient(ctx, { name: 'Vendor', address: DOC_ADDR_CS, source: 'untrusted', untrusted_item_index: 0 });
    ctx.req.masked_text_s8 = 'pay this invoice';
    useFixture(ctx, [paymentsCall('pay this invoice', [llmItem('i', a, r)])]);
    return { ctx };
  }

  it('C-401 E9: pasted invoice with default per-payment limit 100 → 120 USDC is refused by V-13 (LIMIT_PER_TX); spec ambiguity: §19 E9 does not mention the limit', async () => {
    const { ctx } = e9();
    const run = await toSummary(ctx);
    expectError(run.s10 as StepResult, 'LIMIT_PER_TX', { amount: '120', max: '100' });
  });

  it('C-293 E9: with per_tx_max raised, the summary carries "From attached content: 120 USDC to 0xaAAA…1111. You confirmed it."; only the confirmed pair is handed off', async () => {
    const { ctx } = e9();
    setLimits(ctx, { per_tx_max: { USDC: '200', ETH: '0.05' } });
    const run = await toSummary(ctx);
    const text = summaryText(run);
    expect(text).toContain('- From attached content: 120 USDC to 0xaAAA…1111. You confirmed it.');
    expect(text).toContain('1. Send 120 USDC to Vendor (0xaAAA…1111) on Base Sepolia.');
    await s12.step(ctx);
    expect(ctx.exec.submissions[0]?.envelope.intents).toHaveLength(1);
    expect(JSON.stringify(ctx.exec.submissions[0]?.envelope)).not.toContain('Vendor');
  });

  it('E-flow guard: a rejected hand-off leaves the request unconfirmed and all stores untouched (E1 shape)', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '60') });
    const a = addAmount(ctx, '50');
    const r = addAradhya(ctx);
    ctx.req.masked_text_s8 = `Send ${a} to ${r}`;
    useFixture(ctx, [paymentsCall(a, [llmItem('i', a, r)])]);
    await toSummary(ctx);
    ctx.exec.responses = [{ status: 'rejected', message: 'wallet locked' }];
    const res = await s12.step(ctx);
    expect(expectError(res, 'EXECUTION_REJECTED', { message: 'wallet locked' })).toBe(
      "Your wallet couldn't accept this: wallet locked",
    );
    expect(ctx.repos.tables.db6).toEqual([]);
    expect(ctx.repos.tables.db8_history).toEqual([]);
  });
});

// keep imports referenced for lint
void ([] as Array<PlanI | Answer>);
