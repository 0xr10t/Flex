// Lane C — review-round regressions: R3-1 (untrusted payee stays untrusted through a same-request DB2 row) and the
// R2-gap "Don't pay this one" (a removed payee must not reach LLM #4; S7 masks it as [person]).
import { describe, expect, it } from 'vitest';
import { maskStep } from '../../../src/pipeline/s7-mask.js';
import { coinTypeFor } from '../../../src/recipients/ens.js';
import { BASE, Driver, EVIL_A, contact, expectQuestion, makeCtx, nthAddress } from './helpers.js';

const CONTENT_WORDING = /attached content/;

describe('R3-1: an untrusted payee resolved via a same-request DB2 row stays untrusted', () => {
  function docCtx() {
    const ctx = makeCtx({
      text: 'pay the invoice',
      spans: [
        { text: 'bob.eth', kind: 'ens', source: 'untrusted', noSpan: true },
        { text: EVIL_A, kind: 'address', source: 'untrusted', noSpan: true },
      ],
    });
    ctx.ens.set('bob.eth', coinTypeFor(ctx.config, BASE), EVIL_A);
    return ctx;
  }

  it('R3-1: payee 2 (same address) is asked with the content wording and the "Don\'t pay this one" chip', async () => {
    const ctx = docCtx();
    const d = new Driver(ctx);
    await d.start();
    await d.chip('ens_lookup'); // privacy fix 4
    expectQuestion(d, 'Q_ADDRESS_CORRECT');
    await d.chip('yes');
    expectQuestion(d, 'Q_NAME_FOR_ADDRESS');
    await d.text('Bob');
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT');
    expect(q.text).toMatch(CONTENT_WORDING);
    expect(q.chips.map((c) => c.id)).toContain('dont_pay');
  });

  it('R3-1: "Yes" on payee 2 resolves at once (no second name question), source untrusted, DB3 rows untrusted', async () => {
    const ctx = docCtx();
    const d = new Driver(ctx);
    await d.start();
    await d.chip('ens_lookup'); // privacy fix 4
    await d.chip('yes');
    await d.text('Bob');
    const before = ctx.repos.db2.findByAddress(EVIL_A).length;
    await d.chip('yes');
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.repos.db2.findByAddress(EVIL_A)).toHaveLength(before); // no second add_contact
    expect(ctx.req.resolved).toHaveLength(2);
    expect(ctx.req.resolved[1]).toMatchObject({ source: 'untrusted', is_contact: true });
    await maskStep(ctx);
    expect(ctx.req.recipients).toHaveLength(2);
    for (const r of ctx.req.recipients) expect(ctx.repos.db3.get(r.placeholder)?.source).toBe('untrusted');
  });

  it('R3-1: "Don\'t pay this one" on payee 2 removes it', async () => {
    const ctx = docCtx();
    const d = new Driver(ctx);
    await d.start();
    await d.chip('ens_lookup'); // privacy fix 4
    await d.chip('yes');
    await d.text('Bob');
    await d.chip('dont_pay');
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.spans).toHaveLength(1);
    expect(ctx.req.resolved).toHaveLength(1);
  });

  it('R3-1 (findByEnsName path): two untrusted ENS spans with the same normalized name → the second is asked, not a contact', async () => {
    const ctx = makeCtx({
      text: 'pay the invoice',
      spans: [
        { text: 'bob.eth', kind: 'ens', source: 'untrusted', noSpan: true },
        { text: 'BOB.ETH', kind: 'ens', source: 'untrusted', noSpan: true },
      ],
    });
    ctx.ens.set('bob.eth', coinTypeFor(ctx.config, BASE), EVIL_A);
    const d = new Driver(ctx);
    await d.start();
    await d.chip('ens_lookup'); // privacy fix 4
    await d.chip('yes');
    await d.text('Bob');
    // Privacy fix 4: the second document name is asked about before any lookup, even though it matches the first.
    expectQuestion(d, 'Q_WHO_IS');
    await d.chip('ens_lookup');
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT');
    expect(q.text).toMatch(CONTENT_WORDING);
    expect(ctx.req.resolved).toHaveLength(1);
  });

  it('R3-1 guard: a DB2 contact that existed before the request still resolves an untrusted payee as contact, no question', async () => {
    const ctx = makeCtx({
      text: 'pay the invoice',
      spans: [{ text: nthAddress(7), kind: 'address', source: 'untrusted', noSpan: true }],
    });
    contact(ctx, 'Kabir', nthAddress(7));
    const d = new Driver(ctx);
    await d.start();
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved[0]).toMatchObject({ source: 'contact', display_name: 'Kabir' });
  });

  it('R3-1 guard: a typed (non-untrusted) payee hitting a row added earlier in the same request resolves as contact', async () => {
    const ctx = makeCtx({
      text: `pay ${EVIL_A} and then ${EVIL_A}`,
      spans: [
        { text: EVIL_A, kind: 'address', source: 'user' },
        { text: EVIL_A, kind: 'address', source: 'user' },
      ],
    });
    const d = new Driver(ctx);
    await d.start();
    await d.chip('yes');
    await d.text('Eve');
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved).toHaveLength(2);
    expect(ctx.req.resolved[1]).toMatchObject({ source: 'contact', is_contact: true });
  });
});

describe('R2-gap: a payee removed with "Don\'t pay this one" does not reach LLM #4', () => {
  const typed = `pay ${EVIL_A} 5 and mihir 7`;
  const build = () =>
    makeCtx({
      text: typed,
      spans: [
        { text: EVIL_A, kind: 'address', source: 'untrusted' },
        { text: 'mihir', kind: 'name' },
      ],
    });

  it('typed-text range: S7 replaces the removed span with [person]', async () => {
    const ctx = build();
    const d = new Driver(ctx);
    await d.start();
    await d.chip('dont_pay');
    expect(d.last).toEqual({ kind: 'continue' });
    expect(await maskStep(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.req.masked_text_s8).toContain('[person]');
    expect(ctx.req.masked_text_s8).not.toContain(EVIL_A);
  });

  it('typed-text range that does not match its text → INTERNAL_ERROR with rule s7_span_mismatch', async () => {
    const ctx = build();
    const sp = ctx.req.spans[0];
    if (sp?.span) sp.span = { ...sp.span, start: sp.span.start + 1, end: sp.span.end + 1 };
    const d = new Driver(ctx);
    await d.start();
    await d.chip('dont_pay');
    expect(await maskStep(ctx)).toEqual({ kind: 'error', code: 'INTERNAL_ERROR' });
    expect(ctx.log.lines.some((l) => l.rule_id === 's7_span_mismatch')).toBe(true);
  });

  it('document payee (span null) whose exact text also appears in the typed text → swept to [person]', async () => {
    const ctx = makeCtx({
      text: `pay the invoice ${EVIL_A} and pay mihir 7`,
      spans: [
        { text: EVIL_A, kind: 'address', source: 'untrusted', noSpan: true },
        { text: 'mihir', kind: 'name' },
      ],
    });
    const d = new Driver(ctx);
    await d.start();
    await d.chip('dont_pay');
    expect(await maskStep(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.req.masked_text_s8).toContain('[person]');
    expect(ctx.req.masked_text_s8).not.toContain(EVIL_A);
  });
});
