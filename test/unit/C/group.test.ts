// Lane C — §9.6 group sends (steps 1–11), I-25, E4, §13.4 Q_GROUP_PARENT / Q_GROUP_CHAIN / Q_GROUP_MEMBERS,
// §13.1 "Skipped" notes, §15 ENS_INDEXER_UNAVAILABLE / GROUP_EMPTY.
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE } from '../../../src/contracts/catalog.js';
import type { EnsClient } from '../../../src/contracts/io.js';
import type { Address } from '../../../src/contracts/types.js';
import { MEMBER_CONCURRENCY, MEMBER_TIMEOUT_MS, resolveMembers, triageMembers } from '../../../src/recipients/group.js';
import { TEST_WALLET } from '../../fakes/context.js';
import {
  ARB,
  BASE,
  COIN,
  Driver,
  SEPOLIA,
  WALLET_CS,
  expectCleanLogs,
  expectError,
  expectQuestion,
  makeCtx,
  nthAddress,
  type CtxOptions,
} from './helpers.js';

const A = nthAddress(1);
const B = nthAddress(2);
const C = nthAddress(3);

/** "Send 10 usdc to everyone on the list with @iitr.ac.in subdomain" (E4) with optional chain word. */
function groupCtx(o: { parent?: string; marker?: string; chain?: boolean; extra?: Partial<CtxOptions> } = {}) {
  const marker = o.marker ?? '@iitr.ac.in';
  const parent = o.parent ?? 'iitr.ac.in';
  const text = `send amount_aa to everyone with ${marker}${o.chain ? ' on base' : ''}`;
  const ctx = makeCtx({
    text,
    spans: [{ text: marker, kind: 'group' }],
    groups: [{ text: marker, parent }],
    ...(o.chain ? { chains: [{ word: 'base', chain_id: BASE }] } : {}),
    ...o.extra,
  });
  return { ctx, d: new Driver(ctx) };
}

/** iitr.eth with alice, bob (Base) and carol (no Base address); iitr.ac.in unknown to ENS. */
function seedIitr(ctx: ReturnType<typeof groupCtx>['ctx']) {
  ctx.subnames.children.set('iitr.eth', ['carol.iitr.eth', 'bob.iitr.eth', 'alice.iitr.eth']);
  ctx.ens.set('alice.iitr.eth', COIN[BASE], A).set('bob.iitr.eth', COIN.DEFAULT, B).set('carol.iitr.eth', COIN[ARB], C);
}

describe('C-446 §9.6 group sends (S6)', () => {
  it('keeps untrusted group provenance on every selected member after ENS resolution', async () => {
    const { ctx, d } = groupCtx({
      parent: 'iitr.eth',
      marker: '@iitr.eth',
      chain: true,
      extra: { seedExampleContacts: false },
    });
    ctx.req.spans[0]!.source = 'untrusted';
    seedIitr(ctx);
    await d.start();
    expectQuestion(d, 'Q_GROUP_MEMBERS');
    await d.select(['alice.iitr.eth', 'bob.iitr.eth']);
    expect(d.last).toEqual({ kind: 'continue' });
    const rows = [...ctx.repos.tables.db3.values()];
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.source === 'untrusted')).toBe(true);
    expect(ctx.req.resolved[0]?.source).toBe('untrusted');
    expect(ctx.repos.tables.db2).toHaveLength(0);
  });

  it('C-190 C-192 C-197 C-198 C-297 E4: Q_GROUP_CHAIN → Q_GROUP_PARENT (not in ENS) → Q_GROUP_MEMBERS → DB3 rows', async () => {
    const { ctx, d } = groupCtx();
    seedIitr(ctx);
    await d.start();
    // Step 2: no chain word → Q_GROUP_CHAIN with the allowed ok chains.
    const qc = expectQuestion(d, 'Q_GROUP_CHAIN', 1);
    expect(qc.text).toBe('Which chain should the group be paid on?');
    expect(qc.chips.map((c) => [c.id, c.label])).toEqual([
      ['11155111', 'Sepolia'],
      ['84532', 'Base Sepolia'],
      ['421614', 'Arbitrum Sepolia'],
    ]);
    await d.chip('84532');
    // Step 4: iitr.ac.in is not in ENS.
    const qp = expectQuestion(d, 'Q_GROUP_PARENT', 1);
    expect(qp.text).toBe("iitr.ac.in isn't in ENS. Which .eth name should I use instead?");
    expect(qp.input).toBe('text');
    await d.text('iitr.eth');
    // Step 9.
    const qm = expectQuestion(d, 'Q_GROUP_MEMBERS', 1);
    expect(qm.input).toBe('multiselect');
    expect(qm.text).toBe('Pay these 2 members of iitr.eth? Untick anyone to leave out.');
    expect(qm.chips).toEqual([
      { id: 'alice.iitr.eth', label: 'alice.iitr.eth', disabled: false, detail: '' },
      { id: 'bob.iitr.eth', label: 'bob.iitr.eth', disabled: false, detail: '' },
      { id: 'carol.iitr.eth', label: 'carol.iitr.eth', disabled: true, detail: 'no address on Base Sepolia' },
    ]);
    const db2Before = ctx.repos.tables.db2.length;
    await d.select(['alice.iitr.eth', 'bob.iitr.eth']);
    expect(d.last).toEqual({ kind: 'continue' });
    // Step 10.
    const rows = [...ctx.repos.tables.db3.values()];
    const group = rows.find((r) => r.kind === 'group');
    expect(group).toMatchObject({ name: 'iitr.eth', address: null, chain_id: BASE, source: 'ens' });
    expect(group?.placeholder).toMatch(/^group_[0-9a-f]{8}$/);
    const members = ctx.repos.db3.listMembers(group?.placeholder as `group_${string}`);
    expect(members.map((m) => [m.kind, m.name, m.address, m.chain_id, m.source])).toEqual([
      ['member', 'alice.iitr.eth', A, BASE, 'ens'],
      ['member', 'bob.iitr.eth', B, BASE, 'ens'],
    ]);
    expect(members.every((m) => /^address_[0-9a-f]{8}$/.test(m.placeholder))).toBe(true);
    expect(ctx.repos.tables.db2).toHaveLength(db2Before); // never DB2
    expect(ctx.req.resolved[0]).toMatchObject({
      kind: 'group',
      display_name: 'iitr.eth',
      address: null,
      source: 'ens',
      group: { parent: 'iitr.eth', chain_id: BASE },
    });
    expect(ctx.req.resolved[0]?.group?.members.map((m) => [m.subname, m.payable, m.selected])).toEqual([
      ['alice.iitr.eth', true, true],
      ['bob.iitr.eth', true, true],
      ['carol.iitr.eth', false, false],
    ]);
    expect(ctx.req.notes).toEqual(['Skipped carol.iitr.eth: no address on Base Sepolia.']);
    expectCleanLogs(ctx, ['iitr', 'alice']);
  });

  it('C-189 C-323 §9.6 step 1: parent that fails normalize() → Q_GROUP_PARENT; an invalid answer is re-asked', async () => {
    const { ctx, d } = groupCtx({ marker: '@bad..eth', parent: 'bad..eth', chain: true });
    seedIitr(ctx);
    await d.start();
    const q = expectQuestion(d, 'Q_GROUP_PARENT', 1);
    expect(q.text).toBe("Which ENS name's members should I pay?");
    await d.text('a b.eth');
    expectQuestion(d, 'Q_GROUP_PARENT', 2);
    await d.text('IITR.eth');
    expectQuestion(d, 'Q_GROUP_MEMBERS');
  });

  it('C-192 C-323 §9.7: parents that are not in ENS keep counting; the 4th failure → TOO_MANY_RETRIES', async () => {
    const { ctx, d } = groupCtx({ chain: true });
    seedIitr(ctx);
    await d.start();
    expectQuestion(d, 'Q_GROUP_PARENT', 1);
    await d.text('nope.eth');
    expect(expectQuestion(d, 'Q_GROUP_PARENT', 2).text).toBe(
      "nope.eth isn't in ENS. Which .eth name should I use instead?",
    );
    await d.text('nope2.eth');
    expectQuestion(d, 'Q_GROUP_PARENT', 3);
    await d.text('nope3.eth');
    expectQuestion(d, 'Q_GROUP_PARENT', 4);
    await d.text('nope4.eth');
    expectError(d, 'TOO_MANY_RETRIES');
  });

  it('C-190 §9.6 step 2: exactly one chain word in the prompt → that chain, no Q_GROUP_CHAIN', async () => {
    const { ctx, d } = groupCtx({ parent: 'iitr.eth', marker: '@iitr.eth', chain: true });
    seedIitr(ctx);
    await d.start();
    expectQuestion(d, 'Q_GROUP_MEMBERS');
    expect(d.results.filter((r) => r.kind === 'question')).toHaveLength(1);
  });

  it('C-324 §9.6 step 2: Q_GROUP_CHAIN offers only allowed ok chains; other answers are re-asked', async () => {
    const { ctx, d } = groupCtx({
      parent: 'iitr.eth',
      marker: '@iitr.eth',
      extra: { ok: [BASE, ARB], unavailable: [SEPOLIA] },
    });
    seedIitr(ctx);
    await d.start();
    const q = expectQuestion(d, 'Q_GROUP_CHAIN');
    expect(q.chips.map((c) => c.id)).toEqual(['84532', '421614']);
    await d.chip('11155111');
    expectQuestion(d, 'Q_GROUP_CHAIN', 2);
    await d.text('arbitrum sepolia');
    const m = expectQuestion(d, 'Q_GROUP_MEMBERS');
    // carol has an Arbitrum address; alice only Base; bob via the default coin type.
    expect(m.chips.filter((c) => !c.disabled).map((c) => c.id)).toEqual(['bob.iitr.eth', 'carol.iitr.eth']);
  });

  it('C-324 SQ-C-04 §9.6 step 2: no allowed ok chain to offer → UNSUPPORTED_REQUEST', async () => {
    const { ctx, d } = groupCtx({ parent: 'iitr.eth', marker: '@iitr.eth', extra: { ok: [] } });
    seedIitr(ctx);
    await d.start();
    expectError(d, 'UNSUPPORTED_REQUEST');
  });

  it('C-191 C-376 §9.6 step 3: indexer error/timeout → ENS_INDEXER_UNAVAILABLE with the parent', async () => {
    const { ctx, d } = groupCtx({ parent: 'iitr.eth', marker: '@iitr.eth', chain: true });
    ctx.subnames.failing = true;
    await d.start();
    expect(d.last).toEqual({ kind: 'error', code: 'ENS_INDEXER_UNAVAILABLE', params: { parent: 'iitr.eth' } });
    expect(ERROR_MESSAGE.ENS_INDEXER_UNAVAILABLE({ parent: 'iitr.eth' })).toBe(
      "I can't list the members of iitr.eth right now.",
    );
  });

  it('C-193 C-377 §9.6 step 5: zero subnames → GROUP_EMPTY', async () => {
    const { ctx, d } = groupCtx({ parent: 'iitr.eth', marker: '@iitr.eth', chain: true });
    ctx.subnames.children.set('iitr.eth', []);
    await d.start();
    expect(d.last).toEqual({
      kind: 'error',
      code: 'GROUP_EMPTY',
      params: { parent: 'iitr.eth', chain: 'Base Sepolia' },
    });
    expect(ERROR_MESSAGE.GROUP_EMPTY({ parent: 'iitr.eth', chain: 'Base Sepolia' })).toBe(
      'iitr.eth has no members I can pay on Base Sepolia.',
    );
  });

  it('C-196 C-377 §9.6 step 8: no payable member (all unresolvable or self) → GROUP_EMPTY', async () => {
    const { ctx, d } = groupCtx({ parent: 'iitr.eth', marker: '@iitr.eth', chain: true });
    ctx.subnames.children.set('iitr.eth', ['me.iitr.eth', 'ghost.iitr.eth']);
    ctx.ens.set('me.iitr.eth', COIN.DEFAULT, WALLET_CS);
    await d.start();
    expectError(d, 'GROUP_EMPTY');
    expect(ctx.repos.tables.db3.size).toBe(0);
  });

  it('C-195 C-297 §9.6 step 7: own address removed with the note; duplicates keep the alphabetically first', async () => {
    const { ctx, d } = groupCtx({ parent: 'iitr.eth', marker: '@iitr.eth', chain: true });
    ctx.subnames.children.set('iitr.eth', ['zed.iitr.eth', 'me.iitr.eth', 'amy.iitr.eth', 'bob.iitr.eth']);
    ctx.ens
      .set('zed.iitr.eth', COIN[BASE], A)
      .set('amy.iitr.eth', COIN[BASE], A)
      .set('bob.iitr.eth', COIN[BASE], B)
      .set('me.iitr.eth', COIN[BASE], WALLET_CS);
    await d.start();
    const q = expectQuestion(d, 'Q_GROUP_MEMBERS');
    expect(q.chips.map((c) => c.id)).toEqual(['amy.iitr.eth', 'bob.iitr.eth']);
    await d.select(['amy.iitr.eth', 'bob.iitr.eth']);
    expect(ctx.req.notes).toContain("Skipped me.iitr.eth: that's your own address.");
  });

  it('C-197 C-325 §9.6 step 9: selecting zero, a disabled member or using another answer kind → re-ask', async () => {
    const { ctx, d } = groupCtx({ parent: 'iitr.eth', marker: '@iitr.eth', chain: true });
    seedIitr(ctx);
    await d.start();
    await d.select([]);
    expectQuestion(d, 'Q_GROUP_MEMBERS', 2);
    await d.select(['alice.iitr.eth', 'carol.iitr.eth']);
    expectQuestion(d, 'Q_GROUP_MEMBERS', 3);
    await d.text('all of them');
    expectQuestion(d, 'Q_GROUP_MEMBERS', 4);
    await d.select([]);
    expectError(d, 'TOO_MANY_RETRIES');
    expect(ctx.repos.tables.db3.size).toBe(0);
  });

  it('C-198 C-325 §9.6 step 10: only the selected members get member rows; unticked ones are not selected', async () => {
    const { ctx, d } = groupCtx({ parent: 'iitr.eth', marker: '@iitr.eth', chain: true });
    seedIitr(ctx);
    await d.start();
    await d.select(['bob.iitr.eth']);
    const rows = [...ctx.repos.tables.db3.values()];
    expect(rows.filter((r) => r.kind === 'member').map((r) => r.name)).toEqual(['bob.iitr.eth']);
    expect(rows.filter((r) => r.kind === 'group')).toHaveLength(1);
    expect(ctx.req.resolved[0]?.group?.members.find((m) => m.subname === 'alice.iitr.eth')).toMatchObject({
      payable: true,
      selected: false,
    });
  });

  it('C-199 §9.6 step 11: no size cap (150 members all offered and written)', async () => {
    const { ctx, d } = groupCtx({ parent: 'big.eth', marker: '@big.eth', chain: true });
    const names = Array.from({ length: 150 }, (_, i) => `m${String(i).padStart(3, '0')}.big.eth`);
    ctx.subnames.children.set('big.eth', names);
    names.forEach((n, i) => ctx.ens.set(n, COIN[BASE], nthAddress(100 + i)));
    await d.start();
    const q = expectQuestion(d, 'Q_GROUP_MEMBERS');
    expect(q.chips).toHaveLength(150);
    expect(q.text).toBe('Pay these 150 members of big.eth? Untick anyone to leave out.');
    await d.select(names);
    expect([...ctx.repos.tables.db3.values()].filter((r) => r.kind === 'member')).toHaveLength(150);
  });
});

describe('§9.6 steps 6–7 helpers', () => {
  it('C-194 §9.6 step 6: at most 8 lookups in flight; results in input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const ens: EnsClient = {
      async getAddress(name) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return name.startsWith('x') ? null : nthAddress(Number(name.slice(1, 3)));
      },
    };
    const names = Array.from({ length: 30 }, (_, i) => `m${String(i + 10)}.g.eth`);
    const out = await resolveMembers(ens, makeCtx().config, names, BASE);
    expect(MEMBER_CONCURRENCY).toBe(8);
    expect(peak).toBe(8);
    expect(out.map((m) => m.subname)).toEqual(names);
    expect(out.every((m) => m.address !== null)).toBe(true);
  });

  it("C-194 §9.6 step 6: a lookup slower than the timeout (10 s) or failing → can't pay (null)", async () => {
    expect(MEMBER_TIMEOUT_MS).toBe(10_000);
    const ens: EnsClient = {
      async getAddress(name) {
        if (name.startsWith('slow')) return new Promise<Address | null>(() => undefined);
        if (name.startsWith('err')) throw new Error('rpc down');
        return A;
      },
    };
    const out = await resolveMembers(
      ens,
      makeCtx().config,
      ['slow.g.eth', 'err.g.eth', 'ok.g.eth', 'bad..g.eth'],
      BASE,
      {
        timeoutMs: 20,
      },
    );
    expect(out.map((m) => m.address)).toEqual([null, null, A, null]);
  });

  it('C-195 I-25 §9.6 step 7: triage sorts alphabetically, drops self, dedupes by address (case-insensitive)', () => {
    const t = triageMembers(
      [
        { subname: 'c.g.eth', address: A },
        { subname: 'b.g.eth', address: A.toLowerCase() as Address },
        { subname: 'me.g.eth', address: TEST_WALLET },
        { subname: 'a.g.eth', address: null },
      ],
      TEST_WALLET,
    );
    expect(t.members.map((m) => m.subname)).toEqual(['a.g.eth', 'b.g.eth']);
    expect(t.self).toEqual(['me.g.eth']);
    expect(t.duplicates).toEqual(['c.g.eth']);
  });
});
