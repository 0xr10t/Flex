// Lane C — §9.4 ENS re-check for saved contacts (every table row), I-28, §13.4 Q_ENS_CHANGED, §13.1 note.
import { describe, expect, it } from 'vitest';
import { NOTES } from '../../../src/contracts/catalog.js';
import { shortAddress } from '../../../src/contracts/money.js';
import {
  ARB,
  BASE,
  COIN,
  Driver,
  NEWADDR,
  OTHER,
  RIYA,
  WALLET_CS,
  contact,
  expectCleanLogs,
  expectError,
  expectQuestion,
  makeCtx,
  nthAddress,
} from './helpers.js';

/** Riya saved on Base + Arbitrum with ens_name riya.eth; the payee is the name "Riya". */
function setup(records: Array<[bigint, `0x${string}`]>, opts: { unavailable?: boolean } = {}) {
  const ctx = makeCtx({ text: 'pay Riya', spans: [{ text: 'Riya', kind: 'name' }] });
  contact(ctx, 'Riya', RIYA, [BASE, ARB], 'riya.eth');
  for (const [c, a] of records) ctx.ens.set('riya.eth', c, a);
  if (opts.unavailable) ctx.ens.unavailable.add('riya.eth');
  return { ctx, d: new Driver(ctx) };
}

describe('§9.4 ENS re-check', () => {
  it('C-184 §9.4 "Same address": re-resolved per saved chain → continue, no question, no note', async () => {
    const { ctx, d } = setup([
      [COIN[BASE], RIYA],
      [COIN[ARB], RIYA],
    ]);
    await d.start();
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.ens.calls.map((c) => [c.name, c.coinType])).toEqual([
      ['riya.eth', COIN[BASE]],
      ['riya.eth', COIN[ARB]],
    ]);
    expect(ctx.req.resolved[0]).toMatchObject({ address: RIYA, ens_name: 'riya.eth', source: 'contact' });
    expect(ctx.req.notes).toEqual([]);
  });

  it('C-184 §9.4: same address via the ENSIP-19 default coin type also counts as "same"', async () => {
    const { d } = setup([[COIN.DEFAULT, RIYA]]);
    await d.start();
    expect(d.last).toEqual({ kind: 'continue' });
  });

  it('C-185 C-322 §9.4 "Different address": Q_ENS_CHANGED with chips Use new / Keep saved / Cancel', async () => {
    const { d } = setup([
      [COIN[BASE], NEWADDR],
      [COIN[ARB], NEWADDR],
    ]);
    await d.start();
    const q = expectQuestion(d, 'Q_ENS_CHANGED', 1);
    expect(q.text).toBe(
      `riya.eth now points to ${shortAddress(NEWADDR)} (saved: ${shortAddress(RIYA)}). Use the new address?`,
    );
    expect(q.input).toBe('chips');
    expect(q.chips.map((c) => [c.id, c.label])).toEqual([
      ['use_new', 'Use new address'],
      ['keep_saved', 'Keep saved address'],
      ['cancel', 'Cancel'],
    ]);
  });

  it('C-185 §9.4: "Use new address" updates the address on every DB2 row of this name, then continues', async () => {
    const { ctx, d } = setup([[COIN[BASE], NEWADDR]]);
    await d.start();
    await d.chip('use_new');
    expect(d.last).toEqual({ kind: 'continue' });
    const rows = ctx.repos.db2.findByNameKey('riya');
    expect(rows.map((r) => [r.chain_id, r.address])).toEqual([
      [BASE, NEWADDR],
      [ARB, NEWADDR],
    ]);
    expect(ctx.req.resolved[0]).toMatchObject({ display_name: 'Riya', address: NEWADDR, source: 'contact' });
  });

  it('C-185 §9.4: "Keep saved address" keeps DB2 and the saved address', async () => {
    const { ctx, d } = setup([[COIN[BASE], NEWADDR]]);
    await d.start();
    await d.text('keep saved address');
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.repos.db2.findByNameKey('riya').every((r) => r.address === RIYA)).toBe(true);
    expect(ctx.req.resolved[0]?.address).toBe(RIYA);
  });

  it('C-185 SQ-15 §9.4: "Cancel" → request DISCARDED with the cancelled reply, DB2 unchanged', async () => {
    const { ctx, d } = setup([[COIN[BASE], NEWADDR]]);
    await d.start();
    await d.chip('cancel');
    expect(d.last).toEqual({ kind: 'discard', messages: ['Cancelled. Nothing was sent.'] });
    expect(ctx.repos.db2.findByNameKey('riya').every((r) => r.address === RIYA)).toBe(true);
    expect(ctx.req.resolved).toEqual([]);
  });

  it('C-322 §9.7: an invalid Q_ENS_CHANGED answer is re-asked; the 4th failure → TOO_MANY_RETRIES', async () => {
    const { d } = setup([[COIN[BASE], NEWADDR]]);
    await d.start();
    await d.text('hmm');
    expectQuestion(d, 'Q_ENS_CHANGED', 2);
    await d.text('yes');
    expectQuestion(d, 'Q_ENS_CHANGED', 3);
    await d.chip('nope');
    expectQuestion(d, 'Q_ENS_CHANGED', 4);
    await d.text('?');
    expectError(d, 'TOO_MANY_RETRIES');
  });

  it('C-185 §9.4: "Use new address" pointing at the wallet → SELF_PAYMENT, DB2 unchanged', async () => {
    const { ctx, d } = setup([[COIN[BASE], WALLET_CS]]);
    await d.start();
    await d.chip('use_new');
    expectError(d, 'SELF_PAYMENT');
    expect(ctx.repos.db2.findByNameKey('riya').every((r) => r.address === RIYA)).toBe(true);
  });

  it('C-185 SQ-C-03 §9.4: new address already saved under another name → UNSUPPORTED_REQUEST, DB2 unchanged', async () => {
    const { ctx, d } = setup([[COIN[BASE], OTHER]]);
    contact(ctx, 'Other', OTHER, [BASE]);
    await d.start();
    await d.chip('use_new');
    expectError(d, 'UNSUPPORTED_REQUEST');
    expect(ctx.repos.db2.findByNameKey('riya').every((r) => r.address === RIYA)).toBe(true);
  });

  it('C-185 SQ-C-02 §9.4: two different new addresses on two chains → UNSUPPORTED_REQUEST', async () => {
    const { ctx, d } = setup([
      [COIN[BASE], NEWADDR],
      [COIN[ARB], nthAddress(9)],
    ]);
    await d.start();
    expectError(d, 'UNSUPPORTED_REQUEST');
    expect(ctx.log.lines).toContainEqual(
      expect.objectContaining({ event: 'unsupported_state', rule_id: 'ens_recheck_several_new_addresses' }),
    );
  });

  it('C-186 C-322 §9.4 "No address now": variant text with chips Keep saved / Cancel only', async () => {
    const { ctx, d } = setup([]);
    await d.start();
    const q = expectQuestion(d, 'Q_ENS_CHANGED', 1);
    expect(q.text).toBe('riya.eth no longer has an address. Keep the saved one?');
    expect(q.chips.map((c) => c.id)).toEqual(['keep_saved', 'cancel']);
    await d.chip('use_new');
    expectQuestion(d, 'Q_ENS_CHANGED', 2);
    await d.chip('keep_saved');
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved[0]?.address).toBe(RIYA);
  });

  it('C-186 §9.4 "No address now": Cancel → DISCARDED', async () => {
    const { d } = setup([]);
    await d.start();
    await d.text('Cancel');
    expect(d.last).toMatchObject({ kind: 'discard' });
  });

  it('C-187 C-295 §9.4 "RPC unavailable": saved address used, note "Couldn\'t re-check riya.eth; used the saved address."', async () => {
    const { ctx, d } = setup([], { unavailable: true });
    await d.start();
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved[0]?.address).toBe(RIYA);
    expect(ctx.req.notes).toEqual([NOTES.ENS_RECHECK_FAILED({ ens: 'riya.eth' })]);
    expect(ctx.req.notes[0]).toBe("Couldn't re-check riya.eth; used the saved address.");
    expectCleanLogs(ctx, ['riya']);
  });

  it('C-158 §9.4: a contact without ens_name is never re-checked', async () => {
    const ctx = makeCtx({ text: 'pay Mihir', spans: [{ text: 'Mihir', kind: 'name' }] });
    const d = new Driver(ctx);
    await d.start();
    expect(ctx.ens.calls).toEqual([]);
  });

  it('C-176 §9.4: the re-check also runs when the contact is reached through its ENS name', async () => {
    const ctx = makeCtx({ text: 'pay riya.eth', spans: [{ text: 'riya.eth', kind: 'ens' }] });
    contact(ctx, 'Riya', RIYA, [BASE], 'riya.eth');
    ctx.ens.set('riya.eth', COIN[BASE], NEWADDR);
    const d = new Driver(ctx);
    await d.start();
    expectQuestion(d, 'Q_ENS_CHANGED');
  });
});
