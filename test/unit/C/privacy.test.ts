// Privacy fixes in S6: fix 4 (an ENS name from attached content goes to the network only after "Look it up") and fix 6 (no
// indexer configured → group sends are off, before any question or lookup).
import { describe, expect, it, vi } from 'vitest';
import { ERROR_MESSAGE } from '../../../src/contracts/catalog.js';
import { IndexerUnavailable } from '../../../src/contracts/io.js';
import { createSubnameSource } from '../../../src/recipients/subnames.js';
import { testConfig } from '../../fakes/context.js';
import { BASE, COIN, Driver, EVIL_A, NEWADDR, RIYA, contact, expectQuestion, makeCtx } from './helpers.js';

const LOOKUP_TEXT = 'The attached content names bob.eth. Should I look it up? You can also paste the wallet address.';

function docEns(name = 'bob.eth') {
  const ctx = makeCtx({
    text: 'pay the invoice',
    spans: [{ text: name, kind: 'ens', source: 'untrusted', noSpan: true }],
  });
  ctx.ens.set('bob.eth', COIN.DEFAULT, EVIL_A);
  return { ctx, d: new Driver(ctx) };
}

describe('privacy fix 4: ENS names from attached content', () => {
  it("asks before any lookup: Q_WHO_IS with the content wording and Look it up / Don't pay chips", async () => {
    const { ctx, d } = docEns();
    await d.start();
    const q = expectQuestion(d, 'Q_WHO_IS', 1);
    expect(q.text).toBe(LOOKUP_TEXT);
    expect(q.chips.map((c) => [c.id, c.label])).toEqual([
      ['ens_lookup', 'Look it up'],
      ['dont_pay', "Don't pay this one"],
    ]);
    expect(ctx.ens.calls).toEqual([]);
  });

  it('"Look it up" → the lookup runs, and the address is still marked as coming from the content', async () => {
    const { ctx, d } = docEns();
    await d.start();
    await d.chip('ens_lookup');
    expect(ctx.ens.calls.length).toBeGreaterThan(0);
    expect(new Set(ctx.ens.calls.map((c) => c.name))).toEqual(new Set(['bob.eth']));
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT');
    expect(q.text).toMatch(/This address comes from the attached content, not from you\./);
    expect(q.chips.map((c) => c.id)).toEqual(['yes', 'no_reenter', 'dont_pay']);
  });

  it('a typed "yes" counts as Look it up', async () => {
    const { ctx, d } = docEns();
    await d.start();
    await d.text('yes');
    expect(ctx.ens.calls.length).toBeGreaterThan(0);
    expectQuestion(d, 'Q_ADDRESS_CORRECT');
  });

  it('"Don\'t pay this one" (or a typed "no") removes the payee with no lookup at all', async () => {
    for (const answer of ['chip', 'text'] as const) {
      const { ctx, d } = docEns();
      await d.start();
      if (answer === 'chip') await d.chip('dont_pay');
      else await d.text('no');
      expect(ctx.ens.calls).toEqual([]);
      // The only payee is gone, so S6 asks who to pay.
      expectQuestion(d, 'Q_NO_PAYEE');
      expect(ctx.req.spans).toEqual([]);
    }
  });

  it("pasting an address instead: no lookup, and the payee is now the user's own", async () => {
    const { ctx, d } = docEns();
    await d.start();
    await d.text(NEWADDR);
    expect(ctx.ens.calls).toEqual([]);
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT');
    expect(q.text).not.toMatch(/attached content/);
  });

  it("typing the name itself: the user asked for it, so it is looked up as the user's own", async () => {
    const { ctx, d } = docEns();
    await d.start();
    await d.text('bob.eth');
    expect(ctx.ens.calls.length).toBeGreaterThan(0);
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT');
    expect(q.text).not.toMatch(/attached content/);
  });

  it('anything else is re-asked, still with no lookup', async () => {
    const { ctx, d } = docEns();
    await d.start();
    await d.text('maybe later');
    expectQuestion(d, 'Q_WHO_IS', 2);
    expect(ctx.ens.calls).toEqual([]);
  });

  it('a name matching a contact saved before this request resolves from DB2 with no question', async () => {
    const { ctx, d } = docEns();
    contact(ctx, 'Bob', RIYA, undefined, null);
    // A contact without an ENS name: the match must be on ens_name, so add one that has it.
    const { ctx: ctx2, d: d2 } = docEns();
    contact(ctx2, 'Bobby', RIYA, undefined, 'bob.eth');
    ctx2.ens.set('bob.eth', COIN.DEFAULT, RIYA);
    await d2.start();
    expect(d2.last).toEqual({ kind: 'continue' });
    expect(ctx2.req.resolved[0]).toMatchObject({ display_name: 'Bobby', address: RIYA });
    // Control: the saved contact without an ENS name doesn't match, so that request still asks.
    await d.start();
    expectQuestion(d, 'Q_WHO_IS');
    expect(ctx.ens.calls).toEqual([]);
  });

  it('a name the user typed is looked up straight away (control)', async () => {
    const ctx = makeCtx({ text: 'pay bob.eth', spans: [{ text: 'bob.eth', kind: 'ens' }] });
    ctx.ens.set('bob.eth', COIN.DEFAULT, EVIL_A);
    const d = new Driver(ctx);
    await d.start();
    expect(ctx.ens.calls.length).toBeGreaterThan(0);
    expectQuestion(d, 'Q_ADDRESS_CORRECT');
  });

  it('a content name that is not valid ENS is refused without a lookup (unchanged)', async () => {
    const { ctx, d } = docEns('bad..eth');
    await d.start();
    const q = expectQuestion(d, 'Q_WHO_IS');
    expect(q.text).toMatch(/isn't a valid ENS name/);
    expect(ctx.ens.calls).toEqual([]);
  });

  it('two content names: each is asked about separately before its own lookup', async () => {
    const ctx = makeCtx({
      text: 'pay the invoice',
      spans: [
        { text: 'bob.eth', kind: 'ens', source: 'untrusted', noSpan: true },
        { text: 'eve.eth', kind: 'ens', source: 'untrusted', noSpan: true },
      ],
    });
    ctx.ens.set('bob.eth', COIN.DEFAULT, EVIL_A).set('eve.eth', COIN.DEFAULT, NEWADDR);
    const d = new Driver(ctx);
    await d.start();
    expect(d.q.text).toBe(LOOKUP_TEXT);
    await d.chip('dont_pay');
    const q = expectQuestion(d, 'Q_WHO_IS');
    expect(q.text).toMatch(/names eve\.eth/);
    expect(ctx.ens.calls).toEqual([]);
    await d.chip('ens_lookup');
    expect(new Set(ctx.ens.calls.map((c) => c.name))).toEqual(new Set(['eve.eth']));
  });
});

describe('privacy fix 6: no indexer → group sends are off', () => {
  function groupCtx(indexer: string | null) {
    const ctx = makeCtx({
      text: 'send amount_aa to everyone under iitr.eth on base',
      spans: [{ text: 'everyone under iitr.eth', kind: 'group' }],
      groups: [{ text: 'everyone under iitr.eth', parent: 'iitr.eth' }],
      chains: [{ word: 'base', chain_id: BASE }],
    });
    ctx.config.ens.indexer_url = indexer;
    ctx.subnames.children.set('iitr.eth', ['alice.iitr.eth']);
    ctx.ens.set('alice.iitr.eth', COIN[BASE], RIYA);
    return { ctx, d: new Driver(ctx) };
  }

  it('GROUP_SENDS_OFF naming the parent, before any question, indexer query or lookup', async () => {
    const { ctx, d } = groupCtx(null);
    const spy = vi.spyOn(ctx.subnames, 'listChildren');
    await d.start();
    expect(d.last).toEqual({ kind: 'error', code: 'GROUP_SENDS_OFF', params: { parent: 'iitr.eth' } });
    expect(spy).not.toHaveBeenCalled();
    expect(ctx.ens.calls).toEqual([]);
    expect(ERROR_MESSAGE.GROUP_SENDS_OFF({ parent: 'iitr.eth' })).toMatch(
      /^Paying everyone under iitr\.eth is turned off/,
    );
  });

  it('with an indexer configured, the group flow runs (control)', async () => {
    const { ctx, d } = groupCtx('https://indexer.invalid/graphql');
    const spy = vi.spyOn(ctx.subnames, 'listChildren');
    await d.start();
    expect(spy).toHaveBeenCalledWith('iitr.eth');
    expectQuestion(d, 'Q_GROUP_MEMBERS');
  });

  it('the subname source itself refuses with no URL and never fetches', async () => {
    const fetchFn = vi.fn();
    const cfg = testConfig();
    cfg.ens.indexer_url = null;
    for (const kind of ['ens-subgraph', 'ensnode-omnigraph'] as const) {
      cfg.ens.indexer_kind = kind;
      await expect(createSubnameSource(cfg, fetchFn).listChildren('iitr.eth')).rejects.toBeInstanceOf(
        IndexerUnavailable,
      );
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
