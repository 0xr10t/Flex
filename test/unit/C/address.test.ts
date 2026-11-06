// Lane C — §9.2 addresses (steps 1–5, 7), §9 every path ends at one address, §7.2 DB2 writes, §13.4 Q_ADDRESS_CORRECT /
// Q_ADDRESS_REENTER / address answers, §15 SELF_PAYMENT, §16.1 untrusted addresses, A-21.
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE, QUESTION_VARIANT, REASK_HINT } from '../../../src/contracts/catalog.js';
import { checkAddress, isSelf, looksLikeAddress } from '../../../src/recipients/address.js';
import { TEST_WALLET } from '../../fakes/context.js';
import {
  ARB,
  BASE,
  COIN,
  Driver,
  EVIL_A,
  EVIL_B,
  NEWADDR,
  OTHER,
  SEPOLIA,
  WALLET_CS,
  ZERO,
  contact,
  expectCleanLogs,
  expectError,
  expectQuestion,
  makeCtx,
  nthAddress,
  start,
  typo,
  type CtxOptions,
} from './helpers.js';

/** A saved contact stored with its EIP-55 address (the §19 fixture constants are not valid EIP-55). */
const KABIR = nthAddress(7);
const withKabir = (o: CtxOptions) => {
  const ctx = makeCtx(o);
  contact(ctx, 'Kabir', KABIR, [SEPOLIA, BASE, ARB]);
  return ctx;
};
const startKabir = async (o: CtxOptions) => {
  const ctx = withKabir(o);
  const d = new Driver(ctx);
  await d.start();
  return { ctx, d };
};

const addrSpan = (a: string) => ({ text: `pay ${a}`, spans: [{ text: a, kind: 'address' as const }] });
const docSpan = (a: string) => ({
  text: 'pay the invoice',
  spans: [{ text: a, kind: 'address' as const, source: 'untrusted' as const, noSpan: true }],
});

describe('§9.2 step 1–2 address checks (unit)', () => {
  it('C-165 §9.2 step 1: a valid EIP-55 mixed-case address is accepted unchanged', () => {
    expect(checkAddress(NEWADDR)).toEqual({ ok: true, address: NEWADDR });
  });

  it('C-165 §9.2 step 1: all-lowercase and all-uppercase hex are accepted and checksummed', () => {
    expect(checkAddress(NEWADDR.toLowerCase())).toEqual({ ok: true, address: NEWADDR });
    expect(checkAddress(`0x${NEWADDR.slice(2).toUpperCase()}`)).toEqual({ ok: true, address: NEWADDR });
  });

  it('C-165 §9.2 step 1: mixed case with an invalid checksum → checksum failure', () => {
    expect(checkAddress(typo(NEWADDR))).toEqual({ ok: false, reason: 'checksum' });
  });

  it.each([['0x123'], [`${NEWADDR}0`], ['0xZZ' + 'a'.repeat(38)], ['5aaeb6053f3e94c9b9a09f33669435e7ef1beaed00']])(
    'C-165 §9.2 step 1: %j does not match ^0x[0-9a-fA-F]{40}$',
    (t) => {
      expect(checkAddress(t)).toEqual({ ok: false, reason: 'format' });
      expect(looksLikeAddress(t)).toBe(false);
    },
  );

  it('C-166 §9.2 step 2: the zero address is rejected', () => {
    expect(checkAddress(ZERO)).toEqual({ ok: false, reason: 'zero' });
  });

  it('C-167 §9.2 step 3: self check compares the hex case-insensitively', () => {
    expect(isSelf(TEST_WALLET.toLowerCase(), TEST_WALLET)).toBe(true);
    expect(isSelf(NEWADDR, TEST_WALLET)).toBe(false);
  });
});

describe('C-446 §9.2 address flow (S6)', () => {
  it('C-165 C-334 §9.2 step 1: bad-checksum address in the prompt → Q_ADDRESS_REENTER with the typo hint', async () => {
    const { ctx, d } = await start(addrSpan(typo(NEWADDR)));
    const q = expectQuestion(d, 'Q_ADDRESS_REENTER', 1);
    expect(q.text).toBe(`${REASK_HINT.CHECKSUM_TYPO()} Paste the address.`);
    expect(q.input).toBe('address');
    await d.text(NEWADDR);
    expectQuestion(d, 'Q_ADDRESS_CORRECT');
    expect(ctx.repos.tables.db2).toHaveLength(5);
  });

  it('C-166 §9.2 step 2: the zero address in the prompt → Q_ADDRESS_REENTER with "not a usable address"', async () => {
    const { d } = await start(addrSpan(ZERO));
    const q = expectQuestion(d, 'Q_ADDRESS_REENTER', 1);
    expect(q.text).toBe(`${REASK_HINT.ZERO_ADDRESS()} Paste the address.`);
  });

  it('C-166 C-319 §9.2 step 2: zero address answered to Q_ADDRESS_REENTER → re-ask (attempt+1) with the hint', async () => {
    const { d } = await start(addrSpan(NEWADDR));
    await d.chip('no_reenter');
    expectQuestion(d, 'Q_ADDRESS_REENTER', 2);
    await d.text(ZERO);
    const q = expectQuestion(d, 'Q_ADDRESS_REENTER', 3);
    expect(q.text).toBe(`${REASK_HINT.ZERO_ADDRESS()} Paste the address.`);
  });

  it('C-167 C-375 §9.2 step 3 / §15: the wallet address → SELF_PAYMENT (any case)', async () => {
    const { ctx, d } = await start(addrSpan(WALLET_CS.toLowerCase()));
    expectError(d, 'SELF_PAYMENT');
    expect(ERROR_MESSAGE.SELF_PAYMENT({})).toBe(
      "That's your own address. Moving funds between your own chains isn't a payment I can make.",
    );
    expect(ctx.repos.tables.db2).toHaveLength(5);
  });

  it('C-167 §9.2 step 3: wallet address typed as the answer to Q_ADDRESS_REENTER → SELF_PAYMENT', async () => {
    const { d } = await start(addrSpan(NEWADDR));
    await d.chip('no_reenter');
    await d.text(WALLET_CS);
    expectError(d, 'SELF_PAYMENT');
  });

  it('C-168 §9.2 step 4: an address in DB2 (any case) → known contact, its saved name, source contact', async () => {
    const { ctx, d } = await startKabir(addrSpan(KABIR.toLowerCase()));
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved[0]).toMatchObject({
      kind: 'single',
      display_name: 'Kabir',
      address: KABIR,
      source: 'contact',
      is_contact: true,
      contact_chain_ids: [SEPOLIA, BASE, ARB],
    });
  });

  it('C-169 C-318 §9.2 step 5: new address → proceed question with full address; chips Yes / No, re-enter', async () => {
    const { d } = await start(addrSpan(NEWADDR));
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT', 1);
    expect(q.text).toBe(`You have not paid this recipient before. Do you want to proceed?\nWallet address: ${NEWADDR}`);
    expect(q.input).toBe('chips');
    expect(q.chips.map((c) => [c.id, c.label])).toEqual([
      ['yes', 'Yes'],
      ['no_reenter', 'No, re-enter'],
    ]);
  });

  it('C-318 §13.4: free text "yes" matches the Yes chip; other text re-asks Q_ADDRESS_CORRECT', async () => {
    const { d } = await start(addrSpan(NEWADDR));
    await d.text('maybe');
    expect(expectQuestion(d, 'Q_ADDRESS_CORRECT', 2).text).toBe(
      `You have not paid this recipient before. Do you want to proceed?\nWallet address: ${NEWADDR}`,
    );
    await d.text('YES');
    expectQuestion(d, 'Q_NAME_FOR_ADDRESS', 1);
  });

  it('C-170 C-319 §9.2 step 5a: "No, re-enter" → Q_ADDRESS_REENTER → back to step 1 with the new address', async () => {
    const { d } = await start(addrSpan(NEWADDR));
    await d.chip('no_reenter');
    const r = expectQuestion(d, 'Q_ADDRESS_REENTER', 2);
    expect(r.text).toBe('Paste the address.');
    await d.text(OTHER.toLowerCase());
    expect(expectQuestion(d, 'Q_ADDRESS_CORRECT', 2).text).toBe(
      `You have not paid this recipient before. Do you want to proceed?\nWallet address: ${OTHER}`,
    );
  });

  it('C-170 §9.2 step 5a: re-entered address that is a saved contact → known contact, no question', async () => {
    const { ctx, d } = await startKabir(addrSpan(NEWADDR));
    await d.chip('no_reenter');
    await d.text(KABIR);
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved[0]?.display_name).toBe('Kabir');
  });

  it('C-170 §9.2 step 5a via Q_WHO_IS: Q_ADDRESS_REENTER names the suggested name "{ for name}"', async () => {
    const { d } = await start({ text: 'pay riya', spans: [{ text: 'riya', kind: 'name' }] });
    await d.text(NEWADDR);
    await d.chip('no_reenter');
    expect(expectQuestion(d, 'Q_ADDRESS_REENTER', 2).text).toBe('Paste the address for riya.');
  });

  it('C-319 §13.4: text that is not an address → Q_ADDRESS_REENTER re-asked; 4th failure → TOO_MANY_RETRIES', async () => {
    const { d } = await start(addrSpan(typo(NEWADDR)));
    expectQuestion(d, 'Q_ADDRESS_REENTER', 1);
    await d.text('hello');
    // SQ-04: a plain re-ask drops the earlier hint.
    expect(expectQuestion(d, 'Q_ADDRESS_REENTER', 2).text).toBe('Paste the address.');
    await d.chip('yes');
    expectQuestion(d, 'Q_ADDRESS_REENTER', 3);
    await d.text(typo(NEWADDR));
    expect(expectQuestion(d, 'Q_ADDRESS_REENTER', 4).text).toBe(`${REASK_HINT.CHECKSUM_TYPO()} Paste the address.`);
    await d.text('nope');
    expectError(d, 'TOO_MANY_RETRIES');
  });

  it('C-334 §13.4: an ENS name typed where an address is asked goes through §9.3', async () => {
    const ctx = makeCtx(addrSpan(NEWADDR));
    ctx.ens.set('riya.eth', COIN.DEFAULT, OTHER);
    const d = new Driver(ctx);
    await d.start();
    await d.chip('no_reenter');
    await d.text('Riya.eth');
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT', 2);
    expect(q.text).toBe(
      `You have not paid this recipient before. Do you want to proceed?\nriya.eth → ${OTHER} on Sepolia, Base Sepolia and Arbitrum Sepolia.`,
    );
  });

  it('C-334 §9.3 step 4 via Q_ADDRESS_REENTER: ENS name without an address → re-ask in the ENS wording', async () => {
    const { d } = await start(addrSpan(NEWADDR));
    await d.chip('no_reenter');
    await d.text('ghost.eth');
    expect(expectQuestion(d, 'Q_ADDRESS_REENTER', 3).text).toBe(
      QUESTION_VARIANT.REENTER_ENS_NO_ADDRESS({ ens: 'ghost.eth' }),
    );
  });

  it('C-171 C-320 §9.2 step 5b: Yes → Q_NAME_FOR_ADDRESS (text), no prefill for a bare address', async () => {
    const { d } = await start(addrSpan(NEWADDR));
    await d.chip('yes');
    const q = expectQuestion(d, 'Q_NAME_FOR_ADDRESS', 1);
    expect(q.text).toBe('Save this address as?');
    expect(q.input).toBe('text');
    expect(q.prefill).toBeUndefined();
  });

  it('C-174 C-040 C-320 §9.2 step 7: valid name → add_contact: one row per allowed chain, ens_name NULL, source user', async () => {
    const { ctx, d } = await start(addrSpan(NEWADDR));
    const before = ctx.repos.tables.db2.length;
    await d.chip('yes');
    expect(ctx.repos.tables.db2).toHaveLength(before); // nothing written before the name
    await d.text('  Riya K ');
    expect(d.last).toEqual({ kind: 'continue' });
    const rows = ctx.repos.db2.findByAddress(NEWADDR);
    expect(rows.map((r) => r.chain_id).sort()).toEqual([...ctx.limits.allowed_chain_ids].sort());
    expect(rows.every((r) => r.name === 'Riya K' && r.ens_name === null && r.added_by === 'user_confirmed')).toBe(true);
    expect(ctx.req.resolved[0]).toMatchObject({
      display_name: 'Riya K',
      address: NEWADDR,
      source: 'user',
      is_contact: true,
      ens_name: null,
      pinned_chain_id: null,
    });
  });

  it('C-174 §9.2 step 7: add_contact uses the DB5 allowed chains (not every configured chain)', async () => {
    const ctx = makeCtx(addrSpan(NEWADDR));
    ctx.limits = { ...ctx.limits, allowed_chain_ids: [BASE] };
    const d = new Driver(ctx);
    await d.start();
    await d.chip('yes');
    await d.text('Riya');
    expect(ctx.repos.db2.findByAddress(NEWADDR).map((r) => r.chain_id)).toEqual([BASE]);
  });

  it('C-040 §7.2: "No, re-enter" and abandoned questions never write DB2', async () => {
    const { ctx, d } = await start(addrSpan(NEWADDR));
    await d.chip('no_reenter');
    await d.text(OTHER);
    await d.text('nonsense');
    expect(ctx.repos.tables.db2).toHaveLength(5);
  });

  it('C-156 §9: every resolved payee has exactly one address', async () => {
    const ctx = makeCtx({
      text: `pay Mihir and ${NEWADDR}`,
      spans: [
        { text: 'Mihir', kind: 'name' },
        { text: NEWADDR, kind: 'address' },
      ],
    });
    const d = new Driver(ctx);
    await d.start();
    await d.chip('yes');
    await d.text('Newbie');
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved).toHaveLength(2);
    for (const r of ctx.req.resolved) expect(r.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expectCleanLogs(ctx, ['mihir', 'newbie']);
  });
});

describe('§9.2 step 5 / §16.1 untrusted (document) addresses', () => {
  it('C-169 C-400 §9.2 step 5: content address → content wording + third chip "Don\'t pay this one"', async () => {
    const { d } = await start(docSpan(EVIL_A));
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT', 1);
    expect(q.text).toBe(
      `You have not paid this recipient before. Do you want to proceed?\nWallet address: ${EVIL_A} This address comes from the attached content, not from you.`,
    );
    expect(q.chips.map((c) => c.label)).toEqual(['Yes', 'No, re-enter', "Don't pay this one"]);
  });

  it('C-400 §16.1: a content address that is a saved contact needs no question (source contact)', async () => {
    const { ctx, d } = await startKabir(docSpan(KABIR));
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved[0]).toMatchObject({ display_name: 'Kabir', source: 'contact' });
  });

  it('C-174 §9.2 step 7: confirmed content address → add_contact, resolved with source untrusted', async () => {
    const { ctx, d } = await start(docSpan(EVIL_A));
    await d.chip('yes');
    await d.text('Vendor');
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved[0]).toMatchObject({ source: 'untrusted', display_name: 'Vendor', address: EVIL_A });
    expect(ctx.repos.db2.findByAddress(EVIL_A)).toHaveLength(3);
  });

  it('C-172 §9.2 step 5c: "Don\'t pay this one" removes the payee; the next payee is resolved', async () => {
    const { ctx, d } = await startKabir({
      text: 'pay the invoice',
      spans: [
        { text: EVIL_A, kind: 'address', source: 'untrusted', noSpan: true },
        { text: KABIR, kind: 'address', source: 'untrusted', noSpan: true },
      ],
    });
    await d.chip('dont_pay');
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.spans).toHaveLength(1);
    expect(ctx.req.resolved).toHaveLength(1);
    expect(ctx.req.resolved[0]).toMatchObject({ span_index: 0, display_name: 'Kabir' });
    expect(ctx.repos.db2.findByAddress(EVIL_A)).toEqual([]);
  });

  it('C-172 §9.2 step 5c: no payees left after "Don\'t pay this one" → Q_NO_PAYEE, answered via §9', async () => {
    const { ctx, d } = await start({
      text: 'pay the invoice',
      spans: [
        { text: EVIL_A, kind: 'address', source: 'untrusted', noSpan: true },
        { text: EVIL_B, kind: 'address', source: 'untrusted', noSpan: true },
      ],
    });
    await d.chip('dont_pay');
    await d.text("Don't pay this one");
    const q = expectQuestion(d, 'Q_NO_PAYEE', 1);
    expect(q.text).toBe('Who should receive this? Enter their wallet address, ENS name or saved contact name.');
    expect(q.input).toBe('text');
    await d.text('mihir');
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved).toEqual([expect.objectContaining({ span_index: 0, display_name: 'Mihir' })]);
  });

  it('C-172 §9.2 step 5c: "Don\'t pay this one" is not offered (or accepted) for a typed address', async () => {
    const { d } = await start(addrSpan(NEWADDR));
    await d.chip('dont_pay');
    expectQuestion(d, 'Q_ADDRESS_CORRECT', 2);
  });

  it("C-400 §9.2 step 5a: a re-entered address for a document payee is the user's (no content wording)", async () => {
    const { ctx, d } = await start(docSpan(EVIL_A));
    await d.chip('no_reenter');
    await d.text(NEWADDR);
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT', 2);
    expect(q.text).toBe(`You have not paid this recipient before. Do you want to proceed?\nWallet address: ${NEWADDR}`);
    expect(q.chips.map((c) => c.id)).toEqual(['yes', 'no_reenter']);
    await d.chip('yes');
    await d.text('Fixed');
    expect(ctx.req.resolved[0]).toMatchObject({ source: 'user', address: NEWADDR });
  });

  it('C-400 §9.3 step 7 + §9.2 step 5: content ENS name → ENS wording plus the content sentence', async () => {
    const ctx = makeCtx({
      text: 'pay the invoice',
      spans: [{ text: 'evil.eth', kind: 'ens', source: 'untrusted', noSpan: true }],
    });
    ctx.ens.set('evil.eth', COIN.DEFAULT, EVIL_A);
    const d = new Driver(ctx);
    await d.start();
    // Privacy fix 4: the name from the content is looked up only after "Look it up".
    expectQuestion(d, 'Q_WHO_IS');
    expect(ctx.ens.calls).toEqual([]);
    await d.chip('ens_lookup');
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT');
    expect(q.text).toBe(
      `You have not paid this recipient before. Do you want to proceed?\nevil.eth → ${EVIL_A} on Sepolia, Base Sepolia and Arbitrum Sepolia. This address comes from the attached content, not from you.`,
    );
    expect(q.chips.map((c) => c.id)).toEqual(['yes', 'no_reenter', 'dont_pay']);
  });
});

describe('§9.7 attempt counting in the "No, re-enter" loop', () => {
  it('C-170 §9.7: each "No, re-enter" counts; the 4th failure → TOO_MANY_RETRIES', async () => {
    const { d } = await start(addrSpan(NEWADDR));
    await d.chip('no_reenter'); // failure 1
    expectQuestion(d, 'Q_ADDRESS_REENTER', 2);
    await d.text(OTHER);
    expectQuestion(d, 'Q_ADDRESS_CORRECT', 2);
    await d.chip('no_reenter'); // failure 2
    expectQuestion(d, 'Q_ADDRESS_REENTER', 3);
    await d.text(NEWADDR);
    expectQuestion(d, 'Q_ADDRESS_CORRECT', 3);
    await d.chip('no_reenter'); // failure 3
    expectQuestion(d, 'Q_ADDRESS_REENTER', 4);
    await d.text(OTHER);
    expectQuestion(d, 'Q_ADDRESS_CORRECT', 4);
    await d.chip('no_reenter'); // failure 4
    expectError(d, 'TOO_MANY_RETRIES');
  });

  it('C-200 §9.7: a fresh contact flow for a second payee starts at attempt 1', async () => {
    const ctx = makeCtx({
      text: `pay ${NEWADDR} and ${OTHER}`,
      spans: [
        { text: NEWADDR, kind: 'address' },
        { text: OTHER, kind: 'address' },
      ],
    });
    contact(ctx, 'Placeholder', EVIL_B, [BASE]);
    const d = new Driver(ctx);
    await d.start();
    await d.text('nah');
    expectQuestion(d, 'Q_ADDRESS_CORRECT', 2);
    await d.chip('yes');
    await d.text('First');
    const q = expectQuestion(d, 'Q_ADDRESS_CORRECT', 1);
    expect(q.text).toBe(`You have not paid this recipient before. Do you want to proceed?\nWallet address: ${OTHER}`);
  });
});
