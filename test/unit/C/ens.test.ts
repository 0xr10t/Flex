// Lane C — §9.3 ENS names (steps 1–7), I-07, I-27, §13.4 Q_ENS_CHAIN, §14.5 ENS client.
import { describe, expect, it } from 'vitest';
import { QUESTION_VARIANT } from '../../../src/contracts/catalog.js';
import { shortAddress } from '../../../src/contracts/money.js';
import { coinTypeFor, firstLabel, normalizeEns, resolveOnChain } from '../../../src/recipients/ens.js';
import {
  ARB,
  BASE,
  COIN,
  Driver,
  NEWADDR,
  OTHER,
  RIYA,
  SEPOLIA,
  WALLET_CS,
  contact,
  expectCleanLogs,
  expectError,
  expectQuestion,
  makeCtx,
  nthAddress,
  type CtxOptions,
} from './helpers.js';

const ensSpan = (name: string, extra: Partial<CtxOptions> = {}, tail = ''): CtxOptions => ({
  text: `pay ${name}${tail}`,
  spans: [{ text: name, kind: 'ens' }],
  ...extra,
});

async function run(o: CtxOptions, records: Array<[string, bigint, `0x${string}`]>) {
  const ctx = makeCtx(o);
  for (const [n, c, a] of records) ctx.ens.set(n, c, a);
  const d = new Driver(ctx);
  await d.start();
  return { ctx, d };
}

describe('§9.3 helpers', () => {
  it('C-179 §9.3 step 3 / I-27: coinType 60 for Sepolia, 0x80000000 | chainId for L2s (bigint, no sign overflow)', () => {
    const ctx = makeCtx();
    expect(coinTypeFor(ctx.config, SEPOLIA)).toBe(60n);
    expect(coinTypeFor(ctx.config, BASE)).toBe(0x80000000n + 84532n);
    expect(coinTypeFor(ctx.config, ARB)).toBe(0x80000000n + 421614n);
    expect(coinTypeFor(ctx.config, BASE) > 0n).toBe(true);
  });

  it('C-179 §9.3 step 3: chain coin type first, then the ENSIP-19 default 0x80000000, else null', async () => {
    const ctx = makeCtx();
    ctx.ens.set('a.eth', COIN[BASE], RIYA).set('a.eth', COIN.DEFAULT, OTHER);
    expect(await resolveOnChain(ctx.ens, ctx.config, 'a.eth', BASE)).toBe(RIYA);
    expect(ctx.ens.calls.map((c) => c.coinType)).toEqual([COIN[BASE]]);
    ctx.ens.calls = [];
    expect(await resolveOnChain(ctx.ens, ctx.config, 'a.eth', ARB)).toBe(OTHER);
    expect(ctx.ens.calls.map((c) => c.coinType)).toEqual([COIN[ARB], COIN.DEFAULT]);
    expect(await resolveOnChain(ctx.ens, ctx.config, 'none.eth', SEPOLIA)).toBeNull();
  });

  it('C-175 §9.3 step 1: normalize() is ENSIP-15 (case folded); invalid names give null', () => {
    expect(normalizeEns(' Riya.ETH ')).toBe('riya.eth');
    expect(normalizeEns('bad..eth')).toBeNull();
    expect(normalizeEns('a b.eth')).toBeNull();
  });

  it('C-183 §9.3 step 7: first label of an ENS name', () => {
    expect(firstLabel('riya.eth')).toBe('riya');
    expect(firstLabel('alice.iitr.eth')).toBe('alice');
  });
});

describe('C-446 §9.3 ENS flow (S6)', () => {
  it('C-175 §9.3 step 1: normalize failure → Q_WHO_IS "That isn\'t a valid ENS name. Who is it?"', async () => {
    const { ctx, d } = await run(ensSpan('bad..eth'), []);
    const q = expectQuestion(d, 'Q_WHO_IS', 1);
    expect(q.text).toBe(QUESTION_VARIANT.WHO_IS_INVALID_ENS());
    expect(q.text).toBe("That isn't a valid ENS name. Who is it?");
    expect(ctx.ens.calls).toEqual([]);
    await d.text(NEWADDR);
    expectQuestion(d, 'Q_ADDRESS_CORRECT', 1);
  });

  it('C-176 §9.3 step 2: a DB2 row with this ens_name → resolved like a contact (with the re-check)', async () => {
    const ctx = makeCtx(ensSpan('Riya.eth'));
    contact(ctx, 'Riya', RIYA, [BASE, ARB], 'riya.eth');
    ctx.ens.set('riya.eth', COIN[BASE], RIYA).set('riya.eth', COIN[ARB], RIYA);
    const d = new Driver(ctx);
    await d.start();
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved[0]).toMatchObject({
      display_name: 'Riya',
      address: RIYA,
      ens_name: 'riya.eth',
      source: 'contact',
      contact_chain_ids: [BASE, ARB],
    });
    // Re-check queried each saved chain (§9.4).
    expect(ctx.ens.calls.map((c) => c.coinType)).toEqual([COIN[BASE], COIN[ARB]]);
  });

  it("C-177 §9.3 step 3a: exactly one chain word in the span's clause → only that chain is queried", async () => {
    const { ctx, d } = await run(ensSpan('riya.eth', { chains: [{ word: 'base', chain_id: BASE }] }, ' on base'), [
      ['riya.eth', COIN[BASE], RIYA],
      ['riya.eth', COIN[ARB], OTHER],
    ]);
    expect(ctx.ens.calls.map((c) => c.coinType)).toEqual([COIN[BASE]]);
    expect(expectQuestion(d, 'Q_ADDRESS_CORRECT').text).toBe(`riya.eth → ${RIYA} on Base Sepolia. Correct?`);
  });

  it('C-177 §9.3 step 3a: no chain word in the clause, exactly one in the whole prompt → that chain', async () => {
    const ctx = makeCtx({
      text: 'pay riya.eth 5, and mihir 3 on arbitrum',
      spans: [
        { text: 'riya.eth', kind: 'ens', clause: 0 },
        { text: 'mihir', kind: 'name', clause: 1 },
      ],
      chains: [{ word: 'arbitrum', chain_id: ARB, clause: 1 }],
    });
    ctx.ens.set('riya.eth', COIN[ARB], RIYA);
    const d = new Driver(ctx);
    await d.start();
    expect(ctx.ens.calls.map((c) => c.coinType)).toEqual([COIN[ARB]]);
    expectQuestion(d, 'Q_ADDRESS_CORRECT');
  });

  it('C-178 §9.3 step 3b: two different chain words → not known → every allowed ok chain', async () => {
    const { ctx } = await run(
      ensSpan(
        'riya.eth',
        {
          chains: [
            { word: 'base', chain_id: BASE },
            { word: 'arbitrum', chain_id: ARB },
          ],
        },
        ' on base or arbitrum',
      ),
      [['riya.eth', COIN.DEFAULT, RIYA]],
    );
    expect(ctx.ens.calls.filter((c) => c.coinType !== COIN.DEFAULT).map((c) => c.coinType)).toEqual([
      COIN[SEPOLIA],
      COIN[BASE],
      COIN[ARB],
    ]);
  });

  it('C-178 §9.3 step 3b: chains that are unavailable in DB4 or not allowed in DB5 are not queried', async () => {
    const ctx = makeCtx(ensSpan('riya.eth', { ok: [SEPOLIA, BASE], unavailable: [ARB] }));
    ctx.limits = { ...ctx.limits, allowed_chain_ids: [BASE, ARB] };
    ctx.ens.set('riya.eth', COIN.DEFAULT, RIYA);
    const d = new Driver(ctx);
    await d.start();
    expect(ctx.ens.calls.map((c) => c.coinType)).toEqual([COIN[BASE], COIN.DEFAULT]);
    expect(expectQuestion(d, 'Q_ADDRESS_CORRECT').text).toBe(`riya.eth → ${RIYA} on Base Sepolia. Correct?`);
  });

  it('C-180 §9.3 step 4: no address on any queried chain → Q_ADDRESS_REENTER in the ENS wording', async () => {
    const { d } = await run(ensSpan('riya.eth'), []);
    const q = expectQuestion(d, 'Q_ADDRESS_REENTER', 1);
    expect(q.text).toBe('riya.eth has no address for these chains. Paste an address instead?');
    expect(q.input).toBe('address');
    await d.text(NEWADDR);
    expect(expectQuestion(d, 'Q_ADDRESS_CORRECT', 1).text).toBe(`Is ${NEWADDR} correct?`);
  });

  it('C-181 §9.3 step 5: all found addresses equal → one address, valid on exactly those chains', async () => {
    const { ctx, d } = await run(ensSpan('riya.eth'), [
      ['riya.eth', COIN[SEPOLIA], RIYA],
      ['riya.eth', COIN[ARB], RIYA],
    ]);
    expect(expectQuestion(d, 'Q_ADDRESS_CORRECT').text).toBe(
      `riya.eth → ${RIYA} on Sepolia and Arbitrum Sepolia. Correct?`,
    );
    await d.chip('yes');
    await d.text('Riya');
    expect(ctx.req.resolved[0]).toMatchObject({ ens_chain_ids: [SEPOLIA, ARB], pinned_chain_id: null });
  });

  it('C-182 C-321 §9.3 step 6: different addresses → Q_ENS_CHAIN with "{Chain} ({addr})" chips', async () => {
    const { d } = await run(ensSpan('riya.eth'), [
      ['riya.eth', COIN[SEPOLIA], RIYA],
      ['riya.eth', COIN[BASE], OTHER],
      ['riya.eth', COIN[ARB], OTHER],
    ]);
    const q = expectQuestion(d, 'Q_ENS_CHAIN', 1);
    expect(q.text).toBe('riya.eth has different addresses on different chains. Which one?');
    expect(q.input).toBe('chips');
    expect(q.chips.map((c) => [c.id, c.label])).toEqual([
      [String(SEPOLIA), `Sepolia (${shortAddress(RIYA)})`],
      [String(BASE), `Base Sepolia (${shortAddress(OTHER)})`],
      [String(ARB), `Arbitrum Sepolia (${shortAddress(OTHER)})`],
    ]);
  });

  it('C-182 C-321 §9.3 step 6: the chosen chain pins the recipient; a label typed as text also matches', async () => {
    const { ctx, d } = await run(ensSpan('riya.eth'), [
      ['riya.eth', COIN[SEPOLIA], RIYA],
      ['riya.eth', COIN[BASE], OTHER],
    ]);
    await d.text('which?');
    expectQuestion(d, 'Q_ENS_CHAIN', 2);
    await d.text(`base sepolia (${shortAddress(OTHER)})`);
    expect(expectQuestion(d, 'Q_ADDRESS_CORRECT').text).toBe(`riya.eth → ${OTHER} on Base Sepolia. Correct?`);
    await d.chip('yes');
    await d.text('Riya');
    expect(ctx.req.resolved[0]).toMatchObject({ pinned_chain_id: BASE, ens_chain_ids: [BASE], source: 'ens' });
  });

  it('C-321 §9.7: Q_ENS_CHAIN invalid answers → re-ask; the 4th failure → TOO_MANY_RETRIES', async () => {
    const { d } = await run(ensSpan('riya.eth'), [
      ['riya.eth', COIN[SEPOLIA], RIYA],
      ['riya.eth', COIN[BASE], OTHER],
    ]);
    await d.chip('421614');
    expectQuestion(d, 'Q_ENS_CHAIN', 2);
    await d.text('x');
    expectQuestion(d, 'Q_ENS_CHAIN', 3);
    await d.text('y');
    expectQuestion(d, 'Q_ENS_CHAIN', 4);
    await d.text('z');
    expectError(d, 'TOO_MANY_RETRIES');
  });

  it('C-183 §9.3 step 7 + §9.2 step 3: ENS resolving to the wallet → SELF_PAYMENT', async () => {
    const { d } = await run(ensSpan('me.eth'), [['me.eth', COIN.DEFAULT, WALLET_CS]]);
    expectError(d, 'SELF_PAYMENT');
  });

  it('C-183 §9.3 step 7 + §9.2 step 4: ENS address already in DB2 → known contact, ENS chains carried', async () => {
    const ctx = makeCtx(ensSpan('riya.eth'));
    const saved = nthAddress(3);
    contact(ctx, 'Kabir', saved, [SEPOLIA, BASE, ARB]);
    ctx.ens.set('riya.eth', COIN[BASE], saved);
    const d = new Driver(ctx);
    await d.start();
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved[0]).toMatchObject({ display_name: 'Kabir', source: 'contact', ens_chain_ids: [BASE] });
    expect(ctx.repos.db2.findByAddress(saved).every((r) => r.ens_name === null)).toBe(true);
  });

  it('C-183 I-07 §9.3 step 7: Yes → name prefilled with the first label; add_contact only matched chains, ens_name set, source ens', async () => {
    const { ctx, d } = await run(ensSpan('riya.eth'), [
      ['riya.eth', COIN[BASE], RIYA],
      ['riya.eth', COIN[ARB], RIYA],
    ]);
    const before = ctx.repos.tables.db2.length;
    await d.chip('yes');
    const n = expectQuestion(d, 'Q_NAME_FOR_ADDRESS', 1);
    expect(n.prefill).toBe('riya');
    expect(ctx.repos.tables.db2).toHaveLength(before);
    await d.text('riya');
    expect(d.last).toEqual({ kind: 'continue' });
    const rows = ctx.repos.db2.findByAddress(RIYA);
    expect(rows.map((r) => r.chain_id)).toEqual([BASE, ARB]);
    expect(rows.every((r) => r.ens_name === 'riya.eth' && r.added_by === 'user_confirmed')).toBe(true);
    expect(ctx.req.resolved[0]).toMatchObject({
      display_name: 'riya',
      address: RIYA,
      ens_name: 'riya.eth',
      source: 'ens',
      contact_chain_ids: [BASE, ARB],
      ens_chain_ids: [BASE, ARB],
    });
    expectCleanLogs(ctx, ['riya']);
  });

  it('C-183 §9.3 step 7: "No, re-enter" drops the ENS context; the re-entered address is saved for every allowed chain', async () => {
    const { ctx, d } = await run(ensSpan('riya.eth'), [['riya.eth', COIN[BASE], RIYA]]);
    await d.chip('no_reenter');
    await d.text(NEWADDR);
    expect(expectQuestion(d, 'Q_ADDRESS_CORRECT', 2).text).toBe(`Is ${NEWADDR} correct?`);
    await d.chip('yes');
    await d.text('Riya');
    expect(ctx.repos.db2.findByAddress(NEWADDR)).toHaveLength(3);
    expect(ctx.req.resolved[0]).toMatchObject({ source: 'user', ens_name: null });
  });

  it('C-175 SQ-C-01: ENS RPC failure while resolving a payee → UNSUPPORTED_REQUEST with the state logged', async () => {
    const ctx = makeCtx(ensSpan('riya.eth'));
    ctx.ens.unavailable.add('riya.eth');
    const d = new Driver(ctx);
    await d.start();
    expectError(d, 'UNSUPPORTED_REQUEST');
    expect(ctx.log.lines).toContainEqual(
      expect.objectContaining({ event: 'unsupported_state', rule_id: 'ens_lookup_unavailable' }),
    );
    expectCleanLogs(ctx, ['riya']);
  });
});
