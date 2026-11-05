// Lane D tester: S8 pair payments (§8.9 checks P1–P9, retry path, distributive reuse), §20.1 pairing/checks.
import { describe, expect, it } from 'vitest';
import type { AddressPh, AmountPh } from '../../../src/contracts/types.js';
import { s8 } from '../../../src/pipeline/s8-pair.js';
import type { TestContext } from '../../fakes/context.js';
import { FixtureLlmClient, type FixtureCall } from '../../fakes/llm.js';
import {
  ALICE_CS,
  ARADHYA_CS,
  ARB,
  BASE,
  BOB_CS,
  DOC_ADDR_CS,
  RIYA_CS,
  STRANGER_CS,
  addAmount,
  addAradhya,
  addChainMention,
  addFollowup,
  addGroup,
  addMihir,
  addRecipient,
  addWord,
  ctxD,
  expectError,
  llmItem,
  paymentsCall,
} from './helpers.js';

function useFixture(ctx: TestContext, calls: FixtureCall[]): FixtureLlmClient {
  const llm = new FixtureLlmClient({ calls });
  ctx.llm = llm;
  return llm;
}

const WEEKLY_FRI = { frequency: 'weekly' as const, interval: 1, days_of_week: ['FRI' as const] };

/** E3 shape: two clauses, two amounts, two contacts, two chains. */
function e3(): { ctx: TestContext; a1: AmountPh; a2: AmountPh; r1: AddressPh; r2: AddressPh } {
  const ctx = ctxD();
  const a1 = addAmount(ctx, '40', { clause: 0 });
  const r1 = addAradhya(ctx, 0);
  const a2 = addAmount(ctx, '20', { clause: 1 });
  const r2 = addMihir(ctx, 1);
  addChainMention(ctx, 'base', BASE, 0);
  addChainMention(ctx, 'arbitrum', ARB, 1);
  ctx.req.masked_text_s8 = `Send ${a1} to ${r1} on base, and ${a2} to ${r2} on arbitrum`;
  return { ctx, a1, a2, r1, r2 };
}

function hasCorrection(user: string): boolean {
  return user.split('\n').some((l) => l.startsWith('CORRECTION: '));
}

describe('S8 call and output (§8.9)', () => {
  it('C-131 C-129 E3: payments in model order with the DB1 token; continue', async () => {
    const { ctx, a1, a2, r1, r2 } = e3();
    const llm = useFixture(ctx, [
      paymentsCall(a1, [llmItem('i', a2, r2, ARB), llmItem('i', a1, r1, BASE)]),
    ]);
    const r = await s8.step(ctx);
    expect(r).toEqual({ kind: 'continue' });
    expect(ctx.req.payments).toEqual([
      { ...llmItem('i', a2, r2, ARB), token: 'USDC' },
      { ...llmItem('i', a1, r1, BASE), token: 'USDC' },
    ]);
    expect(llm.recorded).toHaveLength(1);
    expect(llm.recorded[0]?.name).toBe('payments');
    expect(hasCorrection(llm.recorded[0]?.user ?? '')).toBe(false);
    expect(llm.remaining()).toEqual([]);
  });

  it('C-129 §8.9 token comes from DB1 (not the model, not the AmountItem copy); l has token null', async () => {
    const ctx = ctxD({ actions: ['i', 'l'] });
    const a1 = addAmount(ctx, '0.01', { token: 'ETH' });
    ctx.repos.db1.update(a1, { token: 'ETH' });
    const item = ctx.req.amounts[0];
    if (item) item.token = 'USDC'; // stale copy: DB1 is authoritative
    const r1 = addAradhya(ctx);
    const r2 = addMihir(ctx);
    ctx.req.masked_text_s8 = `send ${a1} to ${r1} and stop paying ${r2}`;
    useFixture(ctx, [paymentsCall(a1, [llmItem('i', a1, r1), llmItem('l', null, r2)])]);
    expect((await s8.step(ctx)).kind).toBe('continue');
    expect(ctx.req.payments?.map((p) => p.token)).toEqual(['ETH', null]);
  });

  it('C-124 C-125 C-126 §8.9 schema enums: confirmed amounts only, recipients incl. group + follow-up, S2 chains + "unstated"', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '10');
    const doc = addAmount(ctx, '120', { source: 'untrusted', confirmed: false, untrusted_item_index: 0 });
    const g = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [
        { subname: 'bob.iitr.eth', address: BOB_CS },
        { subname: 'alice.iitr.eth', address: ALICE_CS },
      ],
    }).group;
    const s = addFollowup(ctx, { name: 'Aradhya', address: ARADHYA_CS, last_chain_id: BASE });
    addChainMention(ctx, 'base', BASE);
    ctx.req.masked_text_s8 = `send ${a1} each to ${g} and ${s}`;
    addWord(ctx, 'distributive', 'each');
    const llm = useFixture(ctx, [paymentsCall(a1, [llmItem('i', a1, g, BASE), llmItem('i', a1, s)])]);
    expect((await s8.step(ctx)).kind).toBe('continue');
    const call = llm.recorded[0];
    const props = (
      call?.schema as { properties: { payments: { maxItems: number; items: { properties: Record<string, { enum: unknown[] }> } } } }
    ).properties.payments;
    expect(props.items.properties.amount?.enum).toEqual([a1, null]);
    expect(props.items.properties.amount?.enum).not.toContain(doc);
    expect(props.items.properties.recipient?.enum).toEqual([g, s]);
    expect(props.items.properties.chain?.enum).toEqual([BASE, 'unstated']);
    expect(props.items.properties.kind?.enum).toEqual(['i']);
    // A = 1, R = 1 recipient + 1 session → min(50, 1×2 + 2) = 4
    expect(props.maxItems).toBe(4);
    expect(call?.user).toContain(`SESSION: [{"placeholder":"${s}","last_chain_id":${BASE}}]`);
    expect(call?.user).toContain(`RECIPIENTS: [{"placeholder":"${g}","type":"group"}]`);
    expect(call?.user).not.toContain(doc);
  });

  it('C-401 §8.10 document items are passed as placeholder pairs; untrusted amounts flagged from_attached_content', async () => {
    const ctx = ctxD();
    ctx.req.untrusted = [{ item_index: 0, address: DOC_ADDR_CS, ens_name: null, amount: '120', token: 'USDC' }];
    const a = addAmount(ctx, '120', { source: 'untrusted', confirmed: true, untrusted_item_index: 0 });
    const r = addRecipient(ctx, { name: null, address: DOC_ADDR_CS, source: 'untrusted', untrusted_item_index: 0 });
    ctx.req.masked_text_s8 = 'pay this invoice';
    const llm = useFixture(ctx, [paymentsCall('pay this invoice', [llmItem('i', a, r)])]);
    expect((await s8.step(ctx)).kind).toBe('continue');
    const user = llm.recorded[0]?.user ?? '';
    expect(user).toContain(`AMOUNTS: [{"placeholder":"${a}","token":"USDC","from_attached_content":true}]`);
    expect(user).toContain(`DOCUMENT ITEMS: [{"amount":"${a}","recipient":"${r}"}]`);
    expect(user).not.toContain(DOC_ADDR_CS);
  });

  it('C-131 §8.10 MODEL_FAILED when the LLM call fails twice', async () => {
    const { ctx, a1 } = e3();
    useFixture(ctx, [
      { name: 'payments', match: a1, output: null },
      { name: 'payments', match: a1, output: null, attempt: 2 },
    ]);
    expectError(await s8.step(ctx), 'MODEL_FAILED');
  });
});

describe('S8 retry path (P1–P4, C-130)', () => {
  it('C-130 C-135 P4 clause binding: crossed pairing is retried with a CORRECTION line, retry output is used', async () => {
    const { ctx, a1, a2, r1, r2 } = e3();
    const llm = useFixture(ctx, [
      paymentsCall(a1, [llmItem('i', a1, r2, BASE), llmItem('i', a2, r1, ARB)]),
      paymentsCall('CORRECTION: ', [llmItem('i', a1, r1, BASE), llmItem('i', a2, r2, ARB)]),
    ]);
    expect((await s8.step(ctx)).kind).toBe('continue');
    expect(llm.recorded).toHaveLength(2);
    expect(hasCorrection(llm.recorded[0]?.user ?? '')).toBe(false);
    expect(hasCorrection(llm.recorded[1]?.user ?? '')).toBe(true);
    expect(ctx.req.payments?.map((p) => [p.amount, p.recipient])).toEqual([
      [a1, r1],
      [a2, r2],
    ]);
  });

  it('C-130 C-374 §8.9 second failure → PAIRING_FAILED (exactly two calls)', async () => {
    const { ctx, a1, a2, r1, r2 } = e3();
    const crossed = [llmItem('i', a1, r2, BASE), llmItem('i', a2, r1, ARB)];
    const llm = useFixture(ctx, [paymentsCall(a1, crossed), paymentsCall('CORRECTION: ', crossed)]);
    expectError(await s8.step(ctx), 'PAIRING_FAILED');
    expect(llm.recorded).toHaveLength(2);
    expect(ctx.req.payments).toBeUndefined();
  });

  it('C-135 P4 amount and recipient in different clauses is fine when the recipient clause has no other amount', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '40', { clause: 0 });
    const r1 = addAradhya(ctx, 1);
    ctx.req.masked_text_s8 = `pay ${a1}, to ${r1}`;
    useFixture(ctx, [paymentsCall(a1, [llmItem('i', a1, r1)])]);
    expect((await s8.step(ctx)).kind).toBe('continue');
  });

  it('C-132 P1 i with null amount → retry', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '50');
    const r1 = addAradhya(ctx);
    ctx.req.masked_text_s8 = `send ${a1} to ${r1}`;
    const llm = useFixture(ctx, [
      paymentsCall(a1, [llmItem('i', null, r1)]),
      paymentsCall('CORRECTION: ', [llmItem('i', a1, r1)]),
    ]);
    expect((await s8.step(ctx)).kind).toBe('continue');
    expect(llm.recorded).toHaveLength(2);
    expect(ctx.req.payments?.[0]?.amount).toBe(a1);
  });

  it('C-132 P1 schedule fields on an i → retry', async () => {
    const ctx = ctxD({ actions: ['i', 'k'] });
    const a1 = addAmount(ctx, '50');
    const r1 = addAradhya(ctx);
    ctx.req.masked_text_s8 = `send ${a1} to ${r1}`;
    const llm = useFixture(ctx, [
      paymentsCall(a1, [llmItem('i', a1, r1, 'unstated', WEEKLY_FRI)]),
      paymentsCall('CORRECTION: ', [llmItem('i', a1, r1)]),
    ]);
    expect((await s8.step(ctx)).kind).toBe('continue');
    expect(llm.recorded).toHaveLength(2);
    expect(ctx.req.payments?.[0]?.frequency).toBeNull();
  });

  it('C-132 P1 l with an amount → retry', async () => {
    const ctx = ctxD({ actions: ['i', 'l'] });
    const a1 = addAmount(ctx, '50');
    const r1 = addAradhya(ctx);
    const r2 = addMihir(ctx);
    ctx.req.masked_text_s8 = `send ${a1} to ${r1} and stop paying ${r2}`;
    const llm = useFixture(ctx, [
      paymentsCall(a1, [llmItem('i', a1, r1), llmItem('l', a1, r2)]),
      paymentsCall('CORRECTION: ', [llmItem('i', a1, r1), llmItem('l', null, r2)]),
    ]);
    expect((await s8.step(ctx)).kind).toBe('continue');
    expect(llm.recorded).toHaveLength(2);
  });

  it('C-133 P2 an unused amount placeholder → retry', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '10');
    const a2 = addAmount(ctx, '20');
    const r1 = addAradhya(ctx);
    ctx.req.masked_text_s8 = `send ${a1} and ${a2} to ${r1}`;
    const llm = useFixture(ctx, [
      paymentsCall(a1, [llmItem('i', a1, r1)]),
      paymentsCall('CORRECTION: ', [llmItem('i', a1, r1), llmItem('i', a2, r1)]),
    ]);
    expect((await s8.step(ctx)).kind).toBe('continue');
    expect(llm.recorded).toHaveLength(2);
    // §8.10 rule 4: a recipient may get several payments for several amounts.
    expect(ctx.req.payments).toHaveLength(2);
  });

  it('C-133 P2 an amount used twice without a distributive word → retry', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '10');
    const r1 = addAradhya(ctx);
    const r2 = addMihir(ctx);
    const a2 = addAmount(ctx, '20');
    ctx.req.masked_text_s8 = `send ${a1} to ${r1} and ${a2} to ${r2}`;
    const llm = useFixture(ctx, [
      paymentsCall(a1, [llmItem('i', a1, r1), llmItem('i', a1, r2), llmItem('i', a2, r2)]),
      paymentsCall('CORRECTION: ', [llmItem('i', a1, r1), llmItem('i', a2, r2)]),
    ]);
    expect((await s8.step(ctx)).kind).toBe('continue');
    expect(llm.recorded).toHaveLength(2);
  });

  it('C-133 P2 distributive reuse: "10 each to A and B" uses one amount for both, no retry', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '10');
    const r1 = addAradhya(ctx);
    const r2 = addMihir(ctx);
    addWord(ctx, 'distributive', 'each');
    ctx.req.masked_text_s8 = `send ${a1} each to ${r1} and ${r2}`;
    const llm = useFixture(ctx, [paymentsCall(a1, [llmItem('i', a1, r1), llmItem('i', a1, r2)])]);
    expect((await s8.step(ctx)).kind).toBe('continue');
    expect(llm.recorded).toHaveLength(1);
    expect(ctx.req.payments?.map((p) => p.amount)).toEqual([a1, a1]);
  });

  it('C-134 P3 an unused recipient → retry', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '10');
    const r1 = addAradhya(ctx);
    const r2 = addMihir(ctx);
    addWord(ctx, 'distributive', 'each');
    ctx.req.masked_text_s8 = `send ${a1} each to ${r1} and ${r2}`;
    const llm = useFixture(ctx, [
      paymentsCall(a1, [llmItem('i', a1, r1)]),
      paymentsCall('CORRECTION: ', [llmItem('i', a1, r1), llmItem('i', a1, r2)]),
    ]);
    expect((await s8.step(ctx)).kind).toBe('continue');
    expect(llm.recorded).toHaveLength(2);
  });

  it('C-134 P3 duplicate (amount, recipient) → retry', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '10');
    const r1 = addAradhya(ctx);
    const r2 = addMihir(ctx);
    addWord(ctx, 'distributive', 'each');
    ctx.req.masked_text_s8 = `send ${a1} each to ${r1} and ${r2}`;
    const llm = useFixture(ctx, [
      paymentsCall(a1, [llmItem('i', a1, r1), llmItem('i', a1, r1), llmItem('i', a1, r2)]),
      paymentsCall('CORRECTION: ', [llmItem('i', a1, r1), llmItem('i', a1, r2)]),
    ]);
    expect((await s8.step(ctx)).kind).toBe('continue');
    expect(llm.recorded).toHaveLength(2);
    expect(ctx.req.payments).toHaveLength(2);
  });

  it('C-136 P5 an l with a group recipient → retry (groups only with i)', async () => {
    const ctx = ctxD({ actions: ['i', 'l'] });
    const a1 = addAmount(ctx, '10');
    const g = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [{ subname: 'alice.iitr.eth', address: ALICE_CS }],
    }).group;
    ctx.req.masked_text_s8 = `send ${a1} to ${g}`;
    const llm = useFixture(ctx, [
      paymentsCall(a1, [llmItem('i', a1, g, BASE), llmItem('l', null, g)]),
      paymentsCall('CORRECTION: ', [llmItem('i', a1, g, BASE)]),
    ]);
    expect((await s8.step(ctx)).kind).toBe('continue');
    expect(llm.recorded).toHaveLength(2);
  });
});

describe('S8 checks without retry (P5–P9)', () => {
  it('C-136 C-371 P5 k with a group → GROUP_AUTOPAY_UNSUPPORTED, no retry', async () => {
    const ctx = ctxD({ actions: ['k'] });
    const a1 = addAmount(ctx, '10');
    const g = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [{ subname: 'alice.iitr.eth', address: ALICE_CS }],
    }).group;
    ctx.req.masked_text_s8 = `pay ${g} ${a1} every friday`;
    const llm = useFixture(ctx, [paymentsCall(a1, [llmItem('k', a1, g, 'unstated', WEEKLY_FRI)])]);
    const msg = expectError(await s8.step(ctx), 'GROUP_AUTOPAY_UNSUPPORTED');
    expect(msg).toBe("Repeating payments to a whole group aren't supported yet.");
    expect(llm.recorded).toHaveLength(1);
  });

  it('C-137 C-370 P6 relative amount in a k → RELATIVE_AMOUNT_NOT_ALLOWED, no retry', async () => {
    const ctx = ctxD({ actions: ['k'] });
    const a1 = addAmount(ctx, '40', { relative: 'half', pinned_chain_id: BASE, phrase: 'half my usdc' });
    const r1 = addAradhya(ctx);
    ctx.req.masked_text_s8 = `pay ${r1} ${a1} every friday`;
    const llm = useFixture(ctx, [paymentsCall(a1, [llmItem('k', a1, r1, 'unstated', WEEKLY_FRI)])]);
    const msg = expectError(await s8.step(ctx), 'RELATIVE_AMOUNT_NOT_ALLOWED');
    expect(msg).toBe("I can use 'all' or 'half' only for a one-time payment to one person.");
    expect(llm.recorded).toHaveLength(1);
  });

  it('C-137 P6 relative amount to a group → RELATIVE_AMOUNT_NOT_ALLOWED', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '40', { relative: 'all', pinned_chain_id: BASE, phrase: 'all my usdc' });
    const g = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [{ subname: 'alice.iitr.eth', address: ALICE_CS }],
    }).group;
    ctx.req.masked_text_s8 = `send ${a1} to ${g}`;
    useFixture(ctx, [paymentsCall(a1, [llmItem('i', a1, g, BASE)])]);
    expectError(await s8.step(ctx), 'RELATIVE_AMOUNT_NOT_ALLOWED');
  });

  it('C-137 P6 relative amount used twice (distributive) → RELATIVE_AMOUNT_NOT_ALLOWED', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '40', { relative: 'half', pinned_chain_id: BASE, phrase: 'half my usdc' });
    const r1 = addAradhya(ctx);
    const r2 = addMihir(ctx);
    addWord(ctx, 'distributive', 'each');
    ctx.req.masked_text_s8 = `send ${a1} each to ${r1} and ${r2}`;
    useFixture(ctx, [paymentsCall(a1, [llmItem('i', a1, r1), llmItem('i', a1, r2)])]);
    expectError(await s8.step(ctx), 'RELATIVE_AMOUNT_NOT_ALLOWED');
  });

  it('C-137 P6 relative amount, i, single recipient, used once → allowed', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '40', { relative: 'half', pinned_chain_id: BASE, phrase: 'half my usdc' });
    const r1 = addAradhya(ctx);
    ctx.req.masked_text_s8 = `send ${a1} to ${r1}`;
    useFixture(ctx, [paymentsCall(a1, [llmItem('i', a1, r1)])]);
    expect((await s8.step(ctx)).kind).toBe('continue');
  });

  it('C-138 C-372 C-401 P7 k with an untrusted amount → UNTRUSTED_IN_AUTOPAY, no retry', async () => {
    const ctx = ctxD({ actions: ['k'] });
    const a1 = addAmount(ctx, '10', { source: 'untrusted', confirmed: true, untrusted_item_index: 0 });
    const r1 = addAradhya(ctx);
    ctx.req.masked_text_s8 = `pay ${r1} every friday`;
    const llm = useFixture(ctx, [paymentsCall(r1, [llmItem('k', a1, r1, 'unstated', WEEKLY_FRI)])]);
    const msg = expectError(await s8.step(ctx), 'UNTRUSTED_IN_AUTOPAY');
    expect(msg).toBe('Repeating payments can only use amounts and addresses you typed or saved yourself.');
    expect(llm.recorded).toHaveLength(1);
  });

  it('C-138 P7 k with an untrusted non-contact recipient → UNTRUSTED_IN_AUTOPAY', async () => {
    const ctx = ctxD({ actions: ['k'] });
    const a1 = addAmount(ctx, '10');
    const r1 = addRecipient(ctx, { name: null, address: STRANGER_CS, source: 'untrusted', untrusted_item_index: 0 });
    ctx.req.masked_text_s8 = `pay ${a1} every friday`;
    useFixture(ctx, [paymentsCall(a1, [llmItem('k', a1, r1, 'unstated', WEEKLY_FRI)])]);
    expectError(await s8.step(ctx), 'UNTRUSTED_IN_AUTOPAY');
  });

  it('C-138 C-401 P7 k with an untrusted recipient that is an existing DB2 contact → allowed', async () => {
    const ctx = ctxD({ actions: ['k'] });
    const a1 = addAmount(ctx, '10');
    const r1 = addRecipient(ctx, { name: 'Aradhya', address: ARADHYA_CS, source: 'untrusted', untrusted_item_index: 0 });
    ctx.req.masked_text_s8 = `pay ${a1} every friday`;
    useFixture(ctx, [paymentsCall(a1, [llmItem('k', a1, r1, 'unstated', WEEKLY_FRI)])]);
    expect((await s8.step(ctx)).kind).toBe('continue');
  });

  it('C-139 C-369 P8 split word + one amount + two recipients → SPLIT_UNSUPPORTED, no retry', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '30');
    const r1 = addAradhya(ctx);
    const r2 = addMihir(ctx);
    addWord(ctx, 'split', 'split');
    ctx.req.masked_text_s8 = `split ${a1} between ${r1} and ${r2}`;
    const llm = useFixture(ctx, [paymentsCall(a1, [llmItem('i', a1, r1), llmItem('i', a1, r2)])]);
    const msg = expectError(await s8.step(ctx), 'SPLIT_UNSUPPORTED');
    expect(msg).toBe('Tell me how much each person should get, e.g. "15 to A and 15 to B".');
    expect(llm.recorded.length).toBeLessThanOrEqual(1);
  });

  it('C-140 C-373 P9 ENS-pinned recipient with a different stated chain → CHAIN_CONFLICT {name, chain, other}, no retry', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '10');
    const r1 = addRecipient(ctx, {
      name: null,
      ens_name: 'riya.eth',
      address: RIYA_CS,
      source: 'ens',
      pinned_chain_id: BASE,
      ens_chain_ids: [BASE],
    });
    addChainMention(ctx, 'arbitrum', ARB);
    ctx.req.masked_text_s8 = `send ${a1} to ${r1} on arbitrum`;
    const llm = useFixture(ctx, [paymentsCall(a1, [llmItem('i', a1, r1, ARB)])]);
    const msg = expectError(await s8.step(ctx), 'CHAIN_CONFLICT', {
      name: 'riya.eth',
      chain: 'Base Sepolia',
      other: 'Arbitrum Sepolia',
    });
    expect(msg).toBe('riya.eth can only be paid on Base Sepolia, but you asked for Arbitrum Sepolia.');
    expect(llm.recorded).toHaveLength(1);
  });

  it('C-140 P9 relative amount pinned to one chain with a different stated chain → CHAIN_CONFLICT', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '40', { relative: 'half', pinned_chain_id: BASE, phrase: 'half my usdc on base' });
    const r1 = addMihir(ctx);
    addChainMention(ctx, 'arbitrum', ARB);
    ctx.req.masked_text_s8 = `send ${a1} to ${r1} on arbitrum`;
    useFixture(ctx, [paymentsCall(a1, [llmItem('i', a1, r1, ARB)])]);
    expectError(await s8.step(ctx), 'CHAIN_CONFLICT', { chain: 'Base Sepolia', other: 'Arbitrum Sepolia' });
  });

  it('C-140 P9 pinned chain equal to the stated chain passes', async () => {
    const ctx = ctxD();
    const a1 = addAmount(ctx, '10');
    const r1 = addRecipient(ctx, {
      name: null,
      ens_name: 'riya.eth',
      address: RIYA_CS,
      source: 'ens',
      pinned_chain_id: BASE,
      ens_chain_ids: [BASE],
    });
    addChainMention(ctx, 'base', BASE);
    ctx.req.masked_text_s8 = `send ${a1} to ${r1} on base`;
    useFixture(ctx, [paymentsCall(a1, [llmItem('i', a1, r1, BASE)])]);
    expect((await s8.step(ctx)).kind).toBe('continue');
  });
});
