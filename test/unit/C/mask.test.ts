// Lane C — §8.8 S7 masking, §7.3 rules 5–6, §17.2 step 4 follow-up placeholder reuse, §8.6 rule 6 `[person]` (CCR C-1).
import { describe, expect, it } from 'vitest';
import { lastChainFor, s7 } from '../../../src/pipeline/s7-mask.js';
import type { AddressPh, RequestId, Span } from '../../../src/contracts/types.js';
import { ARADHYA } from '../../fakes/context.js';
import {
  ARB,
  BASE,
  COIN,
  Driver,
  NEWADDR,
  OTHER,
  RIYA,
  SEPOLIA,
  expectCleanLogs,
  makeCtx,
  nthAddress,
  type CtxOptions,
} from './helpers.js';

async function resolveAndMask(o: CtxOptions, prep?: (ctx: ReturnType<typeof makeCtx>) => void) {
  const ctx = makeCtx(o);
  prep?.(ctx);
  const d = new Driver(ctx);
  await d.start();
  return { ctx, d };
}

const db3Rows = (ctx: ReturnType<typeof makeCtx>) => [...ctx.repos.tables.db3.values()];

describe('§8.8 S7 mask recipients', () => {
  it('C-119 C-122 §8.8: single payee → new address_ placeholder + DB3 single row (chain NULL), masked_text_s8', async () => {
    const { ctx, d } = await resolveAndMask({
      text: 'Send amount_a1b2c3d4 to ARADHYA',
      spans: [{ text: 'ARADHYA', kind: 'name' }],
    });
    expect(d.last).toEqual({ kind: 'continue' });
    expect(await s7.step(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.req.recipients).toHaveLength(1);
    const ref = ctx.req.recipients[0];
    expect(ref).toMatchObject({
      span_index: 0,
      type: 'person',
      source: 'contact',
      followup: false,
      last_chain_id: null,
    });
    expect(ref?.placeholder).toMatch(/^address_[0-9a-f]{8}$/);
    expect(ctx.repos.db3.get(ref?.placeholder as AddressPh)).toMatchObject({
      kind: 'single',
      session_id: ctx.req.session_id,
      request_id: ctx.req.request_id,
      name: 'Aradhya',
      address: ARADHYA,
      ens_name: null,
      chain_id: null,
      group_placeholder: null,
      source: 'contact',
    });
    expect(ctx.req.masked_text_s8).toBe(`Send amount_a1b2c3d4 to ${ref?.placeholder}`);
    expect(ctx.req.state).toBe('RECIPIENTS_MASKED');
    expectCleanLogs(ctx, ['aradhya']);
  });

  it('C-119 §8.8: an ENS recipient pinned by Q_ENS_CHAIN → DB3 chain_id = pinned chain, ens_name and source ens', async () => {
    const { ctx, d } = await resolveAndMask({ text: 'pay riya.eth', spans: [{ text: 'riya.eth', kind: 'ens' }] }, (c) =>
      c.ens.set('riya.eth', COIN[SEPOLIA], RIYA).set('riya.eth', COIN[BASE], OTHER),
    );
    await d.chip(String(BASE));
    await d.chip('yes');
    await d.text('Riya');
    await s7.step(ctx);
    const ph = ctx.req.recipients[0]?.placeholder as AddressPh;
    expect(ctx.repos.db3.get(ph)).toMatchObject({
      kind: 'single',
      name: 'Riya',
      address: OTHER,
      ens_name: 'riya.eth',
      chain_id: BASE,
      source: 'ens',
    });
  });

  it('C-119 §8.8: a confirmed content address keeps source untrusted in DB3; a document payee is not in the text', async () => {
    const { ctx, d } = await resolveAndMask({
      text: 'pay the invoice',
      spans: [{ text: NEWADDR, kind: 'address', source: 'untrusted', noSpan: true }],
    });
    await d.chip('yes');
    await d.text('Vendor');
    await s7.step(ctx);
    const ref = ctx.req.recipients[0];
    expect(ref?.source).toBe('untrusted');
    expect(ctx.repos.db3.get(ref?.placeholder as AddressPh)).toMatchObject({ source: 'untrusted', address: NEWADDR });
    expect(ctx.req.masked_text_s8).toBe('pay the invoice');
  });

  it('C-045 §7.3 rule 5: the same payee twice → two address placeholders and two DB3 rows', async () => {
    const { ctx } = await resolveAndMask({
      text: 'send amount_11111111 to Mihir and amount_22222222 to mihir',
      spans: [
        { text: 'Mihir', kind: 'name' },
        { text: 'mihir', kind: 'name' },
      ],
    });
    await s7.step(ctx);
    const [a, b] = ctx.req.recipients;
    expect(a?.placeholder).not.toBe(b?.placeholder);
    expect(db3Rows(ctx)).toHaveLength(2);
    expect(ctx.req.masked_text_s8).toBe(
      `send amount_11111111 to ${a?.placeholder} and amount_22222222 to ${b?.placeholder}`,
    );
  });

  it('C-046 §7.3 rule 6: a new request for the same contact gets a new placeholder (never reused)', async () => {
    const first = await resolveAndMask({ text: 'pay Mihir', spans: [{ text: 'Mihir', kind: 'name' }] });
    await s7.step(first.ctx);
    const second = makeCtx({ text: 'pay Mihir', spans: [{ text: 'Mihir', kind: 'name' }] });
    second.repos = first.ctx.repos;
    second.req.request_id = 'req_000000000002' as RequestId;
    const d = new Driver(second);
    await d.start();
    await s7.step(second);
    expect(second.req.recipients[0]?.placeholder).not.toBe(first.ctx.req.recipients[0]?.placeholder);
    expect(db3Rows(second)).toHaveLength(2);
  });

  it('C-120 §8.8: group → reuses the §9.6 group_ placeholder; S7 writes no new DB3 row', async () => {
    const { ctx, d } = await resolveAndMask(
      {
        text: 'send amount_aa to everyone under iitr.eth on base',
        spans: [{ text: 'everyone under iitr.eth', kind: 'group' }],
        groups: [{ text: 'everyone under iitr.eth', parent: 'iitr.eth' }],
        chains: [{ word: 'base', chain_id: BASE }],
      },
      (c) => {
        c.subnames.children.set('iitr.eth', ['alice.iitr.eth']);
        c.ens.set('alice.iitr.eth', COIN[BASE], nthAddress(1));
      },
    );
    await d.select(['alice.iitr.eth']);
    const before = db3Rows(ctx).length;
    await s7.step(ctx);
    expect(db3Rows(ctx)).toHaveLength(before);
    const group = db3Rows(ctx).find((r) => r.kind === 'group');
    expect(ctx.req.recipients[0]).toMatchObject({
      placeholder: group?.placeholder,
      type: 'group',
      source: 'ens',
      followup: false,
    });
    expect(ctx.req.masked_text_s8).toBe(`send amount_aa to ${group?.placeholder} on base`);
  });

  it('C-121 C-417 §17.2 step 4: follow-up payee reuses the earlier placeholder (no new DB3 row), SESSION, last chain', async () => {
    const ctx = makeCtx({ text: 'Send amount_bbbbbbbb more' });
    const earlier = ctx.repos.db3.mint({
      session_id: ctx.req.session_id,
      request_id: 'req_00000000000e',
      kind: 'single',
      name: 'Aradhya',
      address: ARADHYA,
      ens_name: null,
      chain_id: null,
      group_placeholder: null,
      source: 'contact',
    }) as AddressPh;
    ctx.repos.db8.appendHistory({
      session_id: ctx.req.session_id,
      request_id: 'req_00000000000e',
      payments_json: JSON.stringify([{ kind: 'i', amount: 'amount_aaaaaaaa', recipient: earlier, chain: BASE }]),
      handed_off_at: '2026-11-05T17:00:00Z',
    });
    ctx.req.spans = [
      {
        text: 'Aradhya',
        kind: 'name',
        role: 'payee',
        span: null,
        source: 'user',
        followup_placeholder: earlier,
        untrusted_item_index: null,
      },
    ];
    const d = new Driver(ctx);
    await d.start();
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved[0]).toMatchObject({ address: ARADHYA, source: 'session', display_name: 'Aradhya' });
    expect(ctx.ens.calls).toEqual([]);
    const before = db3Rows(ctx).length;
    await s7.step(ctx);
    expect(db3Rows(ctx)).toHaveLength(before);
    expect(ctx.req.recipients).toEqual([
      { placeholder: earlier, span_index: 0, type: 'person', source: 'session', followup: true, last_chain_id: BASE },
    ]);
    expect(ctx.req.masked_text_s8).toBe('Send amount_bbbbbbbb more');
  });

  it('C-417 §17.2 step 4: lastChainFor reads the most recent history entry naming the placeholder', () => {
    const ph = 'address_0f1e2d3c' as AddressPh;
    const rows = [
      {
        id: 2,
        session_id: 's',
        request_id: 'r2',
        payments_json: JSON.stringify([{ recipient: ph, chain_id: ARB }]),
        handed_off_at: '',
      },
      {
        id: 1,
        session_id: 's',
        request_id: 'r1',
        payments_json: JSON.stringify([{ recipient: ph, chain: BASE }]),
        handed_off_at: '',
      },
    ];
    expect(lastChainFor(rows, ph)).toBe(ARB);
    expect(lastChainFor(rows.slice(1), ph)).toBe(BASE);
    expect(
      lastChainFor([{ ...rows[1]!, payments_json: JSON.stringify([{ recipient: ph, chain: 'unstated' }]) }], ph),
    ).toBeNull();
    expect(lastChainFor([{ ...rows[1]!, payments_json: 'not json' }], ph)).toBeNull();
    expect(lastChainFor([], ph)).toBeNull();
  });

  it('C-122 §8.6 rule 6 / §8.8 (CCR C-1): mentioned spans → [person]; payees → placeholders', async () => {
    const text = 'send amount_aaaaaaaa to Mihir, my sister Priya said so';
    const { ctx } = await resolveAndMask({ text, spans: [{ text: 'Mihir', kind: 'name' }] });
    const start = text.indexOf('Priya');
    const mentioned: Span[] = [{ text: 'Priya', start, end: start + 5, clause_index: 1 }];
    ctx.req.mentioned_spans = mentioned;
    await s7.step(ctx);
    const ph = ctx.req.recipients[0]?.placeholder;
    expect(ctx.req.masked_text_s8).toBe(`send amount_aaaaaaaa to ${ph}, my sister [person] said so`);
    expect(db3Rows(ctx)).toHaveLength(1); // mentioned: no placeholder, no row
  });

  it('C-118 §8.8: recipients align with spans (span_index) across single, removed and resolved payees', async () => {
    const { ctx, d } = await resolveAndMask({
      text: 'pay Mihir and Aradhya',
      spans: [
        { text: 'Mihir', kind: 'name' },
        { text: 'Aradhya', kind: 'name' },
      ],
    });
    expect(d.last).toEqual({ kind: 'continue' });
    await s7.step(ctx);
    expect(ctx.req.recipients.map((r) => r.span_index)).toEqual([0, 1]);
    expect(ctx.req.masked_text_s8).toMatch(/^pay address_[0-9a-f]{8} and address_[0-9a-f]{8}$/);
  });

  it('C-119 §8.8: S7 is re-entrant (a second call writes no more rows)', async () => {
    const { ctx } = await resolveAndMask({ text: 'pay Mihir', spans: [{ text: 'Mihir', kind: 'name' }] });
    await s7.step(ctx);
    const ph = ctx.req.recipients[0]?.placeholder;
    await s7.step(ctx);
    expect(db3Rows(ctx)).toHaveLength(1);
    expect(ctx.req.recipients[0]?.placeholder).toBe(ph);
  });
});
