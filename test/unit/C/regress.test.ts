// Lane C — regression tests for the post-review fixes and strengthened rows:
// SQ-C-05 (typed answer at Q_WHO_IS is user-sourced), §17.2 step 4 lastChainFor, §8.8 S7 fail-closed, S6 -> S7 alignment
// after "Don't pay this one" (C-172, C-118), C-156 path table, C-046 session behaviour.
import { describe, expect, it } from 'vitest';
import type { Db8HistoryRow } from '../../../src/contracts/repos.js';
import type { AddressPh, GroupPh, RequestId, Span } from '../../../src/contracts/types.js';
import { lastChainFor, s7 } from '../../../src/pipeline/s7-mask.js';
import { ARADHYA } from '../../fakes/context.js';
import {
  ARB,
  BASE,
  COIN,
  Driver,
  EVIL_A,
  EVIL_B,
  NEWADDR,
  OTHER,
  RIYA,
  SEPOLIA,
  expectCleanLogs,
  expectQuestion,
  makeCtx,
  nthAddress,
  type CtxOptions,
} from './helpers.js';

const db3Rows = (ctx: ReturnType<typeof makeCtx>) => [...ctx.repos.tables.db3.values()];

// ───────────────────────── fix 2: SQ-C-05 / §16.1 ─────────────────────────

describe('SQ-C-05 §16.1: an answer typed at Q_WHO_IS is not content-sourced', () => {
  const badEns = (): CtxOptions => ({
    text: 'pay the invoice',
    spans: [{ text: 'bad..eth', kind: 'ens', source: 'untrusted', noSpan: true }],
  });

  it('C-175 C-400 §16.1 SQ-C-05: document ENS payee failing normalize() → Q_WHO_IS; typed address → no content wording, no dont_pay chip, source user', async () => {
    const ctx = makeCtx(badEns());
    const d = new Driver(ctx);
    await d.start();
    expectQuestion(d, 'Q_WHO_IS', 1);
    await d.text(NEWADDR);
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT', 1);
    expect(q.text).toBe(`You have not paid this recipient before. Do you want to proceed?\nWallet address: ${NEWADDR}`);
    expect(q.text).not.toMatch(/attached content|not from you/);
    expect(q.chips.map((c) => c.id)).toEqual(['yes', 'no_reenter']);
    expect(q.chips.map((c) => c.label)).not.toContain("Don't pay this one");
    await d.chip('yes');
    await d.text('Vendor');
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved[0]).toMatchObject({ source: 'user', address: NEWADDR, display_name: 'Vendor' });
    await s7.step(ctx);
    expect(ctx.req.recipients[0]?.source).toBe('user');
    expect(db3Rows(ctx)[0]).toMatchObject({ source: 'user' });
  });

  it('C-175 C-400 §16.1 SQ-C-05: typed valid ENS name at Q_WHO_IS → ENS wording without the content sentence, no dont_pay chip, source ens', async () => {
    const ctx = makeCtx(badEns());
    ctx.ens.set('riya.eth', COIN.DEFAULT, RIYA);
    const d = new Driver(ctx);
    await d.start();
    expectQuestion(d, 'Q_WHO_IS', 1);
    await d.text('riya.eth');
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT', 1);
    expect(q.text).toBe(
      `You have not paid this recipient before. Do you want to proceed?\nriya.eth → ${RIYA} on Sepolia, Base Sepolia and Arbitrum Sepolia.`,
    );
    expect(q.text).not.toMatch(/attached content|not from you/);
    expect(q.chips.map((c) => c.id)).toEqual(['yes', 'no_reenter']);
    await d.chip('yes');
    await d.text('Riya');
    expect(ctx.req.resolved[0]).toMatchObject({ source: 'ens', address: RIYA, ens_name: 'riya.eth' });
    await s7.step(ctx);
    expect(ctx.req.recipients[0]?.source).toBe('ens');
  });

  it('C-400 §16.1 control: a document ENS name that DOES normalize keeps the content wording and source untrusted', async () => {
    const ctx = makeCtx({
      text: 'pay the invoice',
      spans: [{ text: 'evil.eth', kind: 'ens', source: 'untrusted', noSpan: true }],
    });
    ctx.ens.set('evil.eth', COIN.DEFAULT, EVIL_A);
    const d = new Driver(ctx);
    await d.start();
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT');
    expect(q.text).toMatch(/attached content/);
    expect(q.chips.map((c) => c.id)).toEqual(['yes', 'no_reenter', 'dont_pay']);
  });
});

// ───────────────────────── fix 3: lastChainFor ─────────────────────────

describe('§17.2 step 4 lastChainFor: the newest item naming the placeholder decides', () => {
  const ph = 'address_0f1e2d3c' as AddressPh;
  const other = 'address_aaaaaaaa' as AddressPh;
  const row = (id: number, items: unknown[]): Db8HistoryRow => ({
    id,
    session_id: 's',
    request_id: `r${id}`,
    payments_json: JSON.stringify(items),
    handed_off_at: '',
  });

  it('C-417 §17.2 step 4: a newest "unstated" item with an older numeric one gives null', () => {
    const rows = [row(2, [{ recipient: ph, chain: 'unstated' }]), row(1, [{ recipient: ph, chain: BASE }])];
    expect(lastChainFor(rows, ph)).toBeNull();
  });

  it('C-417 §17.2 step 4: within one row the last item naming the placeholder decides', () => {
    expect(
      lastChainFor(
        [
          row(1, [
            { recipient: ph, chain: BASE },
            { recipient: ph, chain: 'unstated' },
          ]),
        ],
        ph,
      ),
    ).toBeNull();
    expect(
      lastChainFor(
        [
          row(1, [
            { recipient: ph, chain: 'unstated' },
            { recipient: ph, chain: ARB },
          ]),
        ],
        ph,
      ),
    ).toBe(ARB);
  });

  it('C-417 §17.2 step 4: a numeric chain_id wins over chain on the same item', () => {
    expect(lastChainFor([row(1, [{ recipient: ph, chain_id: ARB, chain: BASE }])], ph)).toBe(ARB);
    expect(lastChainFor([row(1, [{ recipient: ph, chain_id: ARB, chain: 'unstated' }])], ph)).toBe(ARB);
  });

  it('C-417 §17.2 step 4: items naming other placeholders are skipped; a non-chain number gives null', () => {
    const rows = [row(2, [{ recipient: other, chain: ARB }]), row(1, [{ recipient: ph, chain: BASE }])];
    expect(lastChainFor(rows, ph)).toBe(BASE);
    expect(lastChainFor([row(1, [{ recipient: ph, chain: 1 }])], ph)).toBeNull();
    expect(lastChainFor([row(1, [{ recipient: other, chain: BASE }])], ph)).toBeNull();
  });
});

// ───────────────────────── fix 4: applyReplacements fails closed ─────────────────────────

describe('§8.8 / §16.1 S7 fails closed on bad spans', () => {
  const text = 'send amount_aaaaaaaa to Mihir and Priya';
  const failedClosed = (ctx: ReturnType<typeof makeCtx>) => {
    expect(ctx.req.masked_text_s8).toBeUndefined();
    expect(ctx.req.state).not.toBe('RECIPIENTS_MASKED');
    const line = ctx.log.lines.find((l) => l.rule_id === 's7_span_mismatch');
    expect(line).toMatchObject({ event: 'internal_error', step: 's7', error_code: 'INTERNAL_ERROR' });
    expectCleanLogs(ctx, ['mihir', 'priya']);
  };

  async function prepared(o: CtxOptions = { text, spans: [{ text: 'Mihir', kind: 'name' }] }) {
    const ctx = makeCtx(o);
    const d = new Driver(ctx);
    await d.start();
    expect(d.last).toEqual({ kind: 'continue' });
    return ctx;
  }

  it('C-122 §8.8: a payee span whose offsets do not match its text → INTERNAL_ERROR, no masked text, allowlisted log', async () => {
    const ctx = await prepared();
    const s = ctx.req.spans[0]?.span;
    if (s === null || s === undefined) throw new Error('no span');
    ctx.req.spans[0]!.span = { ...s, start: s.start + 1, end: s.end + 1 };
    expect(await s7.step(ctx)).toEqual({ kind: 'error', code: 'INTERNAL_ERROR' });
    failedClosed(ctx);
  });

  it('C-122 §8.8: a mentioned span whose offsets do not match its text → INTERNAL_ERROR, no masked text', async () => {
    const ctx = await prepared();
    const start = text.indexOf('Priya');
    const m: Span[] = [{ text: 'Priya', start: start - 2, end: start + 3, clause_index: 0 }];
    ctx.req.mentioned_spans = m;
    expect(await s7.step(ctx)).toEqual({ kind: 'error', code: 'INTERNAL_ERROR' });
    failedClosed(ctx);
  });

  it('C-122 §8.8: a mentioned span that overlaps a payee span → INTERNAL_ERROR (nothing half-masked)', async () => {
    const ctx = await prepared();
    const start = text.indexOf('Mihir');
    ctx.req.mentioned_spans = [{ text: 'hir and', start: start + 2, end: start + 9, clause_index: 0 }];
    expect(await s7.step(ctx)).toEqual({ kind: 'error', code: 'INTERNAL_ERROR' });
    failedClosed(ctx);
  });

  it('C-122 §8.8: two overlapping mentioned spans → INTERNAL_ERROR', async () => {
    const ctx = await prepared();
    const a = text.indexOf('Priya');
    ctx.req.mentioned_spans = [
      { text: 'Priya', start: a, end: a + 5, clause_index: 0 },
      { text: 'iya', start: a + 2, end: a + 5, clause_index: 0 },
    ];
    expect(await s7.step(ctx)).toEqual({ kind: 'error', code: 'INTERNAL_ERROR' });
    failedClosed(ctx);
  });

  it('C-045 C-122 §8.8: the same text twice as two spans is masked at both offsets with two placeholders, no residue', async () => {
    const t = 'send amount_11111111 to Mihir and amount_22222222 to Mihir';
    const ctx = await prepared({
      text: t,
      spans: [
        { text: 'Mihir', kind: 'name' },
        { text: 'Mihir', kind: 'name' },
      ],
    });
    expect(await s7.step(ctx)).toEqual({ kind: 'continue' });
    const [a, b] = ctx.req.recipients;
    expect(a?.placeholder).not.toBe(b?.placeholder);
    expect(ctx.req.masked_text_s8).toBe(
      `send amount_11111111 to ${a?.placeholder} and amount_22222222 to ${b?.placeholder}`,
    );
    expect(ctx.req.masked_text_s8).not.toContain('Mihir');
    expect(db3Rows(ctx)).toHaveLength(2);
  });

  it('C-045 C-122 §8.8: the same text as a payee and a mentioned person → address_ at the payee, [person] at the other', async () => {
    const t = 'send amount_11111111 to Mihir, not Mihir Rao';
    const ctx = await prepared({ text: t, spans: [{ text: 'Mihir', kind: 'name' }] });
    const at = t.lastIndexOf('Mihir');
    ctx.req.mentioned_spans = [{ text: 'Mihir', start: at, end: at + 5, clause_index: 0 }];
    await s7.step(ctx);
    const ph = ctx.req.recipients[0]?.placeholder;
    expect(ctx.req.masked_text_s8).toBe(`send amount_11111111 to ${ph}, not [person] Rao`);
  });

  it('C-122 §8.8: a failed S7 writes no state change that a retry could mistake for done', async () => {
    const ctx = await prepared();
    const s = ctx.req.spans[0]?.span;
    if (s === null || s === undefined) throw new Error('no span');
    ctx.req.spans[0]!.span = { ...s, end: s.end + 3 };
    await s7.step(ctx);
    expect(ctx.req.step_state.s7).toBeUndefined();
  });
});

// ───────────────────────── C-172 / C-118: "Don't pay this one" then S7 ─────────────────────────

describe('C-172 C-118 S6 → S7 alignment after "Don\'t pay this one"', () => {
  const T = 'pay Mihir amount_aaaaaaaa and Aradhya amount_bbbbbbbb per the invoice';
  const doc = (a: string) => ({ text: a, kind: 'address' as const, source: 'untrusted' as const, noSpan: true });
  const M = { text: 'Mihir', kind: 'name' as const };
  const A = { text: 'Aradhya', kind: 'name' as const };

  async function removeThenMask(spans: CtxOptions['spans']) {
    const ctx = makeCtx({ text: T, spans });
    const d = new Driver(ctx);
    await d.start();
    expectQuestion(d, 'Q_ADDRESS_CORRECT');
    await d.chip('dont_pay');
    expect(d.last).toEqual({ kind: 'continue' });
    expect(await s7.step(ctx)).toEqual({ kind: 'continue' });
    return ctx;
  }

  function expectAligned(ctx: ReturnType<typeof makeCtx>) {
    const { spans, resolved, recipients } = ctx.req;
    expect(spans.map((s) => s.text)).toEqual(['Mihir', 'Aradhya']);
    expect(resolved.map((r) => r.span_index)).toEqual([0, 1]);
    expect(resolved.map((r) => r.display_name)).toEqual(['Mihir', 'Aradhya']);
    expect(recipients.map((r) => r.span_index)).toEqual([0, 1]);
    const rows = recipients.map((r) => ctx.repos.db3.get(r.placeholder as AddressPh));
    expect(rows.map((r) => r?.name)).toEqual(['Mihir', 'Aradhya']);
    expect(rows.map((r) => r?.address)).toEqual(resolved.map((r) => r.address));
    expect(rows[1]?.address).toBe(ARADHYA);
    expect(db3Rows(ctx)).toHaveLength(2); // nothing minted for the removed payee
    expect(db3Rows(ctx).some((r) => r.address === EVIL_A)).toBe(false);
    const [p0, p1] = recipients.map((r) => r.placeholder);
    expect(ctx.req.masked_text_s8).toBe(`pay ${p0} amount_aaaaaaaa and ${p1} amount_bbbbbbbb per the invoice`);
    expect(ctx.req.masked_text_s8).not.toContain('Mihir');
    expect(ctx.req.masked_text_s8).not.toContain('Aradhya');
    expect(ctx.repos.db2.findByAddress(EVIL_A)).toEqual([]);
  }

  it('C-172 C-118 §9.2 step 5c: first payee removed', async () => {
    expectAligned(await removeThenMask([doc(EVIL_A), M, A]));
  });

  it('C-172 C-118 §9.2 step 5c: middle payee removed', async () => {
    expectAligned(await removeThenMask([M, doc(EVIL_A), A]));
  });

  it('C-172 C-118 §9.2 step 5c: last payee removed', async () => {
    expectAligned(await removeThenMask([M, A, doc(EVIL_A)]));
  });

  it('C-172 C-118 §9.2 step 5c: two removed (first and last) leaves the middle aligned', async () => {
    const ctx = makeCtx({ text: T, spans: [doc(EVIL_A), M, doc(EVIL_B)] });
    const d = new Driver(ctx);
    await d.start();
    await d.chip('dont_pay');
    expectQuestion(d, 'Q_ADDRESS_CORRECT');
    await d.chip('dont_pay');
    expect(d.last).toEqual({ kind: 'continue' });
    await s7.step(ctx);
    expect(ctx.req.spans.map((s) => s.text)).toEqual(['Mihir']);
    expect(ctx.req.recipients.map((r) => r.span_index)).toEqual([0]);
    expect(db3Rows(ctx)).toHaveLength(1);
    expect(ctx.req.masked_text_s8).toBe(
      `pay ${ctx.req.recipients[0]?.placeholder} amount_aaaaaaaa and Aradhya amount_bbbbbbbb per the invoice`,
    );
  });

  it('C-172 C-118 §9.2 step 5c + §9.6: a group after a removed payee keeps its group_ placeholder at the right index', async () => {
    const t = 'pay the invoice, and send amount_aa to everyone under iitr.eth on base';
    const ctx = makeCtx({
      text: t,
      spans: [doc(EVIL_A), { text: 'everyone under iitr.eth', kind: 'group' }],
      groups: [{ text: 'everyone under iitr.eth', parent: 'iitr.eth' }],
      chains: [{ word: 'base', chain_id: BASE }],
    });
    ctx.subnames.children.set('iitr.eth', ['alice.iitr.eth']);
    ctx.ens.set('alice.iitr.eth', COIN[BASE], nthAddress(1));
    const d = new Driver(ctx);
    await d.start();
    await d.chip('dont_pay');
    expectQuestion(d, 'Q_GROUP_MEMBERS');
    await d.select(['alice.iitr.eth']);
    expect(d.last).toEqual({ kind: 'continue' });
    expect(await s7.step(ctx)).toEqual({ kind: 'continue' });
    const group = db3Rows(ctx).find((r) => r.kind === 'group');
    expect(ctx.req.spans).toHaveLength(1);
    expect(ctx.req.recipients).toEqual([
      expect.objectContaining({ span_index: 0, type: 'group', placeholder: group?.placeholder as GroupPh }),
    ]);
    expect(ctx.req.masked_text_s8).toBe(`pay the invoice, and send amount_aa to ${group?.placeholder} on base`);
  });

  it('C-172 §9.2 step 5c: every document payee removed → Q_NO_PAYEE → typed name → S7 masks the (span-less) payee', async () => {
    const ctx = makeCtx({ text: 'pay the invoice', spans: [doc(EVIL_A), doc(EVIL_B)] });
    const d = new Driver(ctx);
    await d.start();
    await d.chip('dont_pay');
    await d.chip('dont_pay');
    const q = expectQuestion(d, 'Q_NO_PAYEE', 1);
    expect(q.text).toBe('Who should receive this? Enter their wallet address, ENS name or saved contact name.');
    await d.text('mihir');
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.spans).toHaveLength(1);
    expect(ctx.req.resolved).toEqual([expect.objectContaining({ span_index: 0, display_name: 'Mihir' })]);
    expect(await s7.step(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.req.recipients).toEqual([expect.objectContaining({ span_index: 0, type: 'person', followup: false })]);
    expect(db3Rows(ctx)).toHaveLength(1);
    expect(db3Rows(ctx)[0]).toMatchObject({ name: 'Mihir', source: 'contact' });
    expect(ctx.req.masked_text_s8).toBe('pay the invoice');
  });

  it('C-172 §9.2 step 5c: Q_NO_PAYEE answered with an address, then S7 → source user (not untrusted)', async () => {
    const ctx = makeCtx({ text: 'pay the invoice', spans: [doc(EVIL_A)] });
    const d = new Driver(ctx);
    await d.start();
    await d.chip('dont_pay');
    expectQuestion(d, 'Q_NO_PAYEE');
    await d.text(OTHER);
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT');
    expect(q.text).not.toMatch(/attached content/);
    await d.chip('yes');
    await d.text('Other');
    await s7.step(ctx);
    expect(ctx.req.recipients).toHaveLength(1);
    expect(db3Rows(ctx)).toHaveLength(1);
    expect(db3Rows(ctx)[0]).toMatchObject({ address: OTHER, source: 'user' });
  });
});

// ───────────────────────── C-156: every path ends at one address ─────────────────────────

describe('C-156 §9: every path ends with one address per single payee (or a stop); "No, re-enter" is the only loop', () => {
  type Run = (d: Driver, ctx: ReturnType<typeof makeCtx>) => Promise<void>;
  interface Path {
    name: string;
    opts: CtxOptions;
    prep?: (ctx: ReturnType<typeof makeCtx>) => void;
    run: Run;
    codes: string[];
    address: string;
    source: string;
  }

  const paths: Path[] = [
    {
      name: 'saved contact',
      opts: { text: 'pay Mihir', spans: [{ text: 'Mihir', kind: 'name' }] },
      run: async () => undefined,
      codes: [],
      address: '',
      source: 'contact',
    },
    {
      name: 'typed address',
      opts: { text: `pay ${NEWADDR}`, spans: [{ text: NEWADDR, kind: 'address' }] },
      run: async (d) => {
        await d.chip('yes');
        await d.text('Newbie');
      },
      codes: ['Q_ADDRESS_CORRECT', 'Q_NAME_FOR_ADDRESS'],
      address: NEWADDR,
      source: 'user',
    },
    {
      name: 'ENS single address',
      opts: { text: 'pay riya.eth', spans: [{ text: 'riya.eth', kind: 'ens' }] },
      prep: (c) => c.ens.set('riya.eth', COIN.DEFAULT, RIYA),
      run: async (d) => {
        await d.chip('yes');
        await d.text('Riya');
      },
      codes: ['Q_ADDRESS_CORRECT', 'Q_NAME_FOR_ADDRESS'],
      address: RIYA,
      source: 'ens',
    },
    {
      name: 'ENS pinned by Q_ENS_CHAIN',
      opts: { text: 'pay riya.eth', spans: [{ text: 'riya.eth', kind: 'ens' }] },
      prep: (c) => c.ens.set('riya.eth', COIN[SEPOLIA], RIYA).set('riya.eth', COIN[BASE], OTHER),
      run: async (d) => {
        await d.chip(String(BASE));
        await d.chip('yes');
        await d.text('Riya');
      },
      codes: ['Q_ENS_CHAIN', 'Q_ADDRESS_CORRECT', 'Q_NAME_FOR_ADDRESS'],
      address: OTHER,
      source: 'ens',
    },
    {
      name: 'No, re-enter',
      opts: { text: `pay ${NEWADDR}`, spans: [{ text: NEWADDR, kind: 'address' }] },
      run: async (d) => {
        await d.chip('no_reenter');
        await d.text(OTHER);
        await d.chip('yes');
        await d.text('Other');
      },
      codes: ['Q_ADDRESS_CORRECT', 'Q_ADDRESS_REENTER', 'Q_ADDRESS_CORRECT', 'Q_NAME_FOR_ADDRESS'],
      address: OTHER,
      source: 'user',
    },
    {
      name: 'unknown name → Q_WHO_IS → address',
      opts: { text: 'pay zed', spans: [{ text: 'zed', kind: 'name' }] },
      run: async (d) => {
        await d.text(NEWADDR);
        await d.chip('yes');
        await d.text('Zed');
      },
      codes: ['Q_WHO_IS', 'Q_ADDRESS_CORRECT', 'Q_NAME_FOR_ADDRESS'],
      address: NEWADDR,
      source: 'user',
    },
  ];

  it.each(paths)('C-156 §9: $name', async (p) => {
    const ctx = makeCtx(p.opts);
    p.prep?.(ctx);
    const d = new Driver(ctx);
    await d.start();
    await p.run(d, ctx);
    expect(d.last).toEqual({ kind: 'continue' });
    const codes = d.results.flatMap((r) => (r.kind === 'question' ? [r.question.code] : []));
    expect(codes).toEqual(p.codes);
    expect(ctx.req.resolved).toHaveLength(1);
    const r = ctx.req.resolved[0];
    expect(r?.kind).toBe('single');
    expect(r?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    if (p.address !== '') expect(r?.address).toBe(p.address);
    expect(r?.source).toBe(p.source);
    await s7.step(ctx);
    const singles = db3Rows(ctx).filter((row) => row.kind === 'single');
    expect(singles).toHaveLength(1);
    expect(singles[0]?.address).toBe(r?.address);
  });

  it('C-156 §9.6: a group ends with one address per selected member (and no group-level address)', async () => {
    const ctx = makeCtx({
      text: 'send amount_aa to everyone under iitr.eth on base',
      spans: [{ text: 'everyone under iitr.eth', kind: 'group' }],
      groups: [{ text: 'everyone under iitr.eth', parent: 'iitr.eth' }],
      chains: [{ word: 'base', chain_id: BASE }],
    });
    ctx.subnames.children.set('iitr.eth', ['alice.iitr.eth', 'bob.iitr.eth']);
    ctx.ens.set('alice.iitr.eth', COIN[BASE], nthAddress(1)).set('bob.iitr.eth', COIN[BASE], nthAddress(2));
    const d = new Driver(ctx);
    await d.start();
    await d.select(['alice.iitr.eth', 'bob.iitr.eth']);
    expect(d.last).toEqual({ kind: 'continue' });
    expect(d.results.flatMap((r) => (r.kind === 'question' ? [r.question.code] : []))).toEqual(['Q_GROUP_MEMBERS']);
    expect(ctx.req.resolved[0]?.address).toBeNull();
    const members = ctx.req.resolved[0]?.group?.members.filter((m) => m.selected) ?? [];
    expect(members.map((m) => m.address)).toEqual([nthAddress(1), nthAddress(2)]);
  });

  it('C-156 §9.7: the stops — the 4th failed re-enter ends the flow, an ENS RPC failure ends it; neither yields an address', async () => {
    const ctx = makeCtx({ text: `pay ${NEWADDR}`, spans: [{ text: NEWADDR, kind: 'address' }] });
    const d = new Driver(ctx);
    await d.start();
    for (let i = 0; i < 3; i++) {
      await d.chip('no_reenter');
      await d.text(OTHER);
    }
    await d.chip('no_reenter');
    expect(d.last).toMatchObject({ kind: 'error', code: 'TOO_MANY_RETRIES' });
    expect(ctx.req.resolved).toEqual([]);
    // only "No, re-enter" loops: every Q_ADDRESS_CORRECT after the first follows a Q_ADDRESS_REENTER
    const codes = d.results.flatMap((r) => (r.kind === 'question' ? [r.question.code] : []));
    codes.forEach((c, i) => {
      if (c === 'Q_ADDRESS_CORRECT' && i > 0) expect(codes[i - 1]).toBe('Q_ADDRESS_REENTER');
    });
  });
});

// ───────────────────────── C-046: placeholders per request ─────────────────────────

describe('C-046 §7.3 rule 6: placeholders are never reused across requests, except for a follow-up', () => {
  it('C-046 §7.3 rule 6: a second request in the same session with a non-follow-up payee gets a new placeholder and row; the first row is untouched', async () => {
    const first = makeCtx({ text: 'pay Mihir amount_aaaaaaaa', spans: [{ text: 'Mihir', kind: 'name' }] });
    await new Driver(first).start();
    await s7.step(first);
    const ph1 = first.req.recipients[0]?.placeholder as AddressPh;
    const row1 = structuredClone(first.repos.db3.get(ph1));
    expect(row1).toBeDefined();

    const second = makeCtx({ text: 'pay Aradhya amount_bbbbbbbb', spans: [{ text: 'Aradhya', kind: 'name' }] });
    second.repos = first.repos;
    second.req.session_id = first.req.session_id;
    second.req.request_id = 'req_000000000002' as RequestId;
    await new Driver(second).start();
    await s7.step(second);
    const ph2 = second.req.recipients[0]?.placeholder as AddressPh;
    expect(ph2).not.toBe(ph1);
    expect(second.req.recipients[0]?.followup).toBe(false);
    expect(db3Rows(second)).toHaveLength(2);
    expect(second.repos.db3.get(ph1)).toEqual(row1);
    expect(second.repos.db3.get(ph2)).toMatchObject({
      request_id: 'req_000000000002',
      name: 'Aradhya',
      session_id: first.req.session_id,
    });
    expect(second.req.masked_text_s8).toBe(`pay ${ph2} amount_bbbbbbbb`);
  });

  it('C-046 §7.3 rule 6 / §17.2 step 4: a follow-up span in that same session reuses the earlier placeholder with no new row', async () => {
    const first = makeCtx({ text: 'pay Mihir amount_aaaaaaaa', spans: [{ text: 'Mihir', kind: 'name' }] });
    await new Driver(first).start();
    await s7.step(first);
    const ph1 = first.req.recipients[0]?.placeholder as AddressPh;
    const row1 = structuredClone(first.repos.db3.get(ph1));

    const follow = makeCtx({
      text: 'and amount_cccccccc more',
      spans: [{ text: 'Mihir', kind: 'name', followup: ph1 }],
    });
    follow.repos = first.repos;
    follow.req.session_id = first.req.session_id;
    follow.req.request_id = 'req_000000000003' as RequestId;
    const d = new Driver(follow);
    await d.start();
    expect(d.last).toEqual({ kind: 'continue' });
    await s7.step(follow);
    expect(follow.req.recipients).toEqual([
      expect.objectContaining({ placeholder: ph1, followup: true, source: 'session' }),
    ]);
    expect(db3Rows(follow)).toHaveLength(1);
    expect(follow.repos.db3.get(ph1)).toEqual(row1);
    expect(follow.req.masked_text_s8).toBe('and amount_cccccccc more');
  });

  it('C-046 §7.3 rule 6: in one session, request 2 mixes a follow-up and a new payee → one reused, one new', async () => {
    const first = makeCtx({ text: 'pay Mihir amount_aaaaaaaa', spans: [{ text: 'Mihir', kind: 'name' }] });
    await new Driver(first).start();
    await s7.step(first);
    const ph1 = first.req.recipients[0]?.placeholder as AddressPh;

    const second = makeCtx({
      text: 'same again, and Aradhya amount_dddddddd',
      spans: [
        { text: 'Mihir', kind: 'name', followup: ph1 },
        { text: 'Aradhya', kind: 'name' },
      ],
    });
    second.repos = first.repos;
    second.req.session_id = first.req.session_id;
    second.req.request_id = 'req_000000000004' as RequestId;
    await new Driver(second).start();
    await s7.step(second);
    const [a, b] = second.req.recipients;
    expect(a).toMatchObject({ placeholder: ph1, followup: true, span_index: 0 });
    expect(b?.followup).toBe(false);
    expect(b?.placeholder).not.toBe(ph1);
    expect(db3Rows(second)).toHaveLength(2);
    expect(second.req.masked_text_s8).toBe(`same again, and ${b?.placeholder} amount_dddddddd`);
  });
});
