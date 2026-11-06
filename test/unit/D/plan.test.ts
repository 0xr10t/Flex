// Lane D tester: S9 plan end to end — §10.1 spendable, §10.2 expansion, §10.3 chain choice, §9.5 silent reuse,
// §17.2 follow-ups, §19 worked examples E1–E7.
import { describe, expect, it, vi } from 'vitest';
import { NOTES } from '../../../src/contracts/catalog.js';
import type { ChainId } from '../../../src/contracts/types.js';
import { s9 } from '../../../src/pipeline/s9-plan.js';
import {
  ALICE_CS,
  ARADHYA_CS,
  ARB,
  BASE,
  BOB_CS,
  CAROL_CS,
  DELEGATE_CS,
  RIYA_CS,
  SEPOLIA,
  STRANGER_CS,
  addAmount,
  addAradhya,
  addAutopay,
  addFollowup,
  addGroup,
  addMihir,
  addRecipient,
  ctxD,
  db6Row,
  expectError,
  pay,
  setLimits,
} from './helpers.js';
import {
  NOW_E6,
  PENDING_OLD,
  PENDING_RECENT,
  amountOf,
  asI,
  asJ,
  asK,
  asL,
  db1Count,
  expectValidPlan,
  iPay,
  kSetup,
  planOf,
  run,
  runOk,
  usdc,
} from './s9-helpers.js';

vi.mock('../../../src/amounts/parse.js', async () => {
  const m = await import('./parse-mock.js');
  return { parseAmountText: (t: string) => m.fakeParseAmountText(t) };
});

const now = (): string => new Date(NOW_E6).toISOString();

describe('C-448 §20.1 plan: §10.1 spendable balance', () => {
  // Base 80, Arbitrum 60: a 50 payment to Aradhya (Base + Arbitrum) picks Base unless Base's spendable drops below 50.
  async function chainWithPending(rows: Parameters<typeof db6Row>[0][]): Promise<ChainId> {
    const ctx = ctxD({ balances: usdc('0', '80', '60') });
    ctx.repos.db6.insertMany(rows.map(db6Row));
    const r = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '50', r)]);
    return asI(plan[plan.length - 1]).chain_id;
  }

  it('C-202 §10.1 pending payment inside the 10 minute window is subtracted (Base 80 − 40 = 40 < 50 → Arbitrum)', async () => {
    expect(await chainWithPending([{ kind: 'payment', amount: '40', created_at: PENDING_RECENT }])).toBe(ARB);
  });

  it('C-202 §10.1 pending row older than 10 minutes is ignored', async () => {
    expect(await chainWithPending([{ kind: 'payment', amount: '40', created_at: PENDING_OLD }])).toBe(BASE);
  });

  it.each(['payment', 'bridge_out', 'autopay_prefund'] as const)(
    'C-202 §10.1 pending kind %s is counted',
    async (kind) => {
      expect(await chainWithPending([{ kind, amount: '40', created_at: PENDING_RECENT }])).toBe(ARB);
    },
  );

  it.each(['bridge_buffer', 'autopay_payment'] as const)('C-202 §10.1 pending kind %s is not counted', async (kind) => {
    expect(await chainWithPending([{ kind, amount: '40', created_at: PENDING_RECENT }])).toBe(BASE);
  });

  it('C-202 §10.1 only status pending is subtracted (executed rows are already in the balance)', async () => {
    expect(
      await chainWithPending([{ kind: 'payment', amount: '40', created_at: PENDING_RECENT, status: 'executed' }]),
    ).toBe(BASE);
  });

  it('C-202 §10.1 pending rows of another chain or token do not reduce this chain/token', async () => {
    expect(
      await chainWithPending([
        { kind: 'payment', amount: '40', created_at: PENDING_RECENT, chain_id: ARB },
        { kind: 'payment', amount: '0.05', token: 'ETH', created_at: PENDING_RECENT },
      ]),
    ).toBe(BASE);
  });

  it('C-202 §10.1 ETH spendable subtracts eth_gas_reserve[c]: Base 0.12 − 0.05 = 0.07 < 0.075 → Arbitrum (0.1 − 0.002)', async () => {
    const ctx = ctxD({ balances: { [BASE]: { ETH: '0.12' }, [ARB]: { ETH: '0.1' } } });
    setLimits(ctx, { eth_gas_reserve: { '11155111': '0.01', '84532': '0.05', '421614': '0.002' } });
    const r = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '0.075', r, 'unstated', { token: 'ETH' })]);
    expect(asI(plan[0]).chain_id).toBe(ARB);
  });

  it('C-202 §10.1 spendable is floored at 0 per chain (a negative chain must not offset another chain)', async () => {
    const ctx = ctxD({
      balances: { [SEPOLIA]: { ETH: '0.01' }, [BASE]: { ETH: '0.001' }, [ARB]: { ETH: '0.003' } },
    });
    const r = addAradhya(ctx);
    // spendable ETH: Sepolia 0 (0.01 − 0.01), Base 0 (0.001 − 0.002 floored), Arbitrum 0.001
    expectError(await run(ctx, [iPay(ctx, '0.01', r, 'unstated', { token: 'ETH' })]), 'INSUFFICIENT_FUNDS', {
      token: 'ETH',
      need: '0.01',
      have: '0.001',
    });
  });

  it('C-202 C-203 §10.1 unavailable chain is excluded as candidate and as bridge source', async () => {
    const ctx = ctxD({ balances: usdc('0', '30', '500') });
    ctx.repos.db4.markUnavailable(ARB, 'Arbitrum Sepolia', now());
    const r = addAradhya(ctx);
    expectError(await run(ctx, [iPay(ctx, '50', r)]), 'INSUFFICIENT_FUNDS', { need: '50', have: '30' });
  });

  it('C-202 §10.1 unavailable chain is skipped when another candidate qualifies', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '500') });
    ctx.repos.db4.markUnavailable(ARB, 'Arbitrum Sepolia', now());
    const r = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '50', r)]);
    expect(asI(plan[0]).chain_id).toBe(BASE);
  });

  it('C-202 §10.1 stated chain that is unavailable → BALANCES_UNAVAILABLE naming that chain', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '80') });
    ctx.repos.db4.markUnavailable(ARB, 'Arbitrum Sepolia', now());
    const r = addAradhya(ctx);
    expectError(await run(ctx, [iPay(ctx, '5', r, ARB)]), 'BALANCES_UNAVAILABLE', { chains: 'Arbitrum Sepolia' });
  });

  it('C-202 §10.1 pinned chain (relative amount) that is unavailable → BALANCES_UNAVAILABLE naming that chain', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '80') });
    ctx.repos.db4.markUnavailable(ARB, 'Arbitrum Sepolia', now());
    const r = addAradhya(ctx);
    expectError(await run(ctx, [iPay(ctx, '5', r, 'unstated', { pinned: ARB })]), 'BALANCES_UNAVAILABLE', {
      chains: 'Arbitrum Sepolia',
    });
  });

  it('C-202 §10.1 ENS-pinned chain that is unavailable → BALANCES_UNAVAILABLE naming that chain', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '80') });
    ctx.repos.db4.markUnavailable(ARB, 'Arbitrum Sepolia', now());
    const r = addRecipient(ctx, {
      name: null,
      ens_name: 'riya.eth',
      address: RIYA_CS,
      source: 'ens',
      pinned_chain_id: ARB,
      ens_chain_ids: [BASE, ARB],
    });
    expectError(await run(ctx, [iPay(ctx, '5', r)]), 'BALANCES_UNAVAILABLE', { chains: 'Arbitrum Sepolia' });
  });
});

describe('§10.3 chain for each payment', () => {
  it('C-207 §10.3 rule 1: relative amount pinned to a chain → that chain even if another has more', async () => {
    const ctx = ctxD({ balances: usdc('0', '500', '10') });
    const r = addMihir(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '5', r, 'unstated', { pinned: ARB })]);
    expect(asI(plan[0]).chain_id).toBe(ARB);
  });

  it('C-207 §10.3 rule 1: ENS chain choice (DB3 chain_id) → that chain even if another has more', async () => {
    const ctx = ctxD({ balances: usdc('0', '500', '10') });
    const r = addRecipient(ctx, {
      name: null,
      ens_name: 'riya.eth',
      address: RIYA_CS,
      source: 'ens',
      pinned_chain_id: ARB,
      ens_chain_ids: [BASE, ARB],
    });
    const plan = await runOk(ctx, [iPay(ctx, '5', r)]);
    expect(asI(plan[0])).toMatchObject({ chain_id: ARB, reused_from_chain_id: null });
  });

  it('C-208 §10.3 rule 2: stated chain wins over a larger balance', async () => {
    const ctx = ctxD({ balances: usdc('0', '10', '500') });
    const r = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '5', r, BASE)]);
    expect(asI(plan[0]).chain_id).toBe(BASE);
  });

  it('C-208 §10.3 rule 2: stated chain outside allowed_chain_ids → CHAIN_NOT_ALLOWED', async () => {
    const ctx = ctxD({ balances: usdc('100', '100', '100') });
    setLimits(ctx, { allowed_chain_ids: [BASE, ARB] });
    const r = addMihir(ctx);
    expectError(await run(ctx, [iPay(ctx, '5', r, SEPOLIA)]), 'CHAIN_NOT_ALLOWED', { chain: 'Sepolia' });
  });

  it('C-209 §10.3 rule 3: user-typed address → every allowed chain is a candidate (largest wins)', async () => {
    const ctx = ctxD({ balances: usdc('90', '50', '10') });
    const r = addRecipient(ctx, { name: null, address: STRANGER_CS, source: 'user' });
    const plan = await runOk(ctx, [iPay(ctx, '5', r)]);
    expect(asI(plan[0]).chain_id).toBe(SEPOLIA);
  });

  it('C-209 §10.3 rule 3: untrusted address → every allowed chain is a candidate', async () => {
    const ctx = ctxD({ balances: usdc('90', '50', '10') });
    const r = addRecipient(ctx, {
      name: null,
      address: STRANGER_CS,
      source: 'untrusted',
      untrusted_item_index: 0,
    });
    const plan = await runOk(ctx, [iPay(ctx, '5', r)]);
    expect(asI(plan[0]).chain_id).toBe(SEPOLIA);
  });

  it('C-209 §10.3 rule 3: untrusted address saved as a contact during this request still has every allowed chain', async () => {
    const ctx = ctxD({ balances: usdc('500', '40', '10') });
    const r = addRecipient(ctx, { name: 'Aradhya', address: ARADHYA_CS, source: 'untrusted', untrusted_item_index: 0 });
    const plan = await runOk(ctx, [iPay(ctx, '5', r)]);
    expect(asI(plan[0]).chain_id).toBe(SEPOLIA);
  });

  it('C-209 §10.3 rule 3: contact → only chains with DB2 rows (Sepolia has more but Aradhya has no Sepolia row)', async () => {
    const ctx = ctxD({ balances: usdc('500', '40', '60') });
    const r = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '5', r)]);
    expect(asI(plan[0])).toMatchObject({ chain_id: ARB, reused_from_chain_id: null });
  });

  it('C-209 §10.3 rule 3: ENS-sourced → only chains whose record returned the address', async () => {
    const ctx = ctxD({ balances: usdc('20', '500', '30') });
    const r = addRecipient(ctx, {
      name: null,
      ens_name: 'riya.eth',
      address: RIYA_CS,
      source: 'ens',
      ens_chain_ids: [SEPOLIA, ARB],
    });
    const plan = await runOk(ctx, [iPay(ctx, '5', r)]);
    expect(asI(plan[0]).chain_id).toBe(ARB);
  });

  it('C-209 §10.3 rule 3: ties are broken by the order of allowed_chain_ids', async () => {
    const ctx = ctxD({ balances: usdc('0', '50', '50') });
    const r = addAradhya(ctx);
    expect(asI((await runOk(ctx, [iPay(ctx, '5', r)]))[0]).chain_id).toBe(BASE);

    const ctx2 = ctxD({ balances: usdc('0', '50', '50') });
    setLimits(ctx2, { allowed_chain_ids: [ARB, BASE, SEPOLIA] });
    const r2 = addAradhya(ctx2);
    expect(asI((await runOk(ctx2, [iPay(ctx2, '5', r2)]))[0]).chain_id).toBe(ARB);
  });

  it('C-209 §10.3 rule 3: only candidates with spendable − assigned ≥ need qualify, then the largest of those', async () => {
    const ctx = ctxD({ balances: usdc('0', '30', '60') });
    const r = addAradhya(ctx);
    expect(asI((await runOk(ctx, [iPay(ctx, '40', r)]))[0]).chain_id).toBe(ARB);
  });

  it('C-212 §10.3 rule 6: assigned tracks need across payments in payment order', async () => {
    const ctx = ctxD({ balances: usdc('0', '50', '45') });
    const a = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '40', a), iPay(ctx, '40', a)]);
    // first → Base (50); Base then has 10 left, so the second goes to Arbitrum (45)
    expect(plan.map((p) => asI(p).chain_id)).toEqual([BASE, ARB]);
  });

  it('C-210 C-188 §10.3 rule 4 + §9.5: contact, no DB2 chain qualifies → any allowed ok chain; no DB2 write; DB3 reused_from_chain_id set; PlanI.reused_from_chain_id; note', async () => {
    const ctx = ctxD({ balances: usdc('100', '0', '0') });
    const a = addAradhya(ctx);
    const before = ctx.repos.db2.findByAddress(ARADHYA_CS).map((r) => r.chain_id);
    const plan = await runOk(ctx, [iPay(ctx, '50', a)]);
    const i = asI(plan[0]);
    expect(i.chain_id).toBe(SEPOLIA);
    expect([BASE, ARB]).toContain(i.reused_from_chain_id);
    expect(ctx.repos.db3.get(a)?.reused_from_chain_id).toBe(i.reused_from_chain_id);
    expect(ctx.repos.db2.findByAddress(ARADHYA_CS).map((r) => r.chain_id)).toEqual(before);
    const from = i.reused_from_chain_id === BASE ? 'Base Sepolia' : 'Arbitrum Sepolia';
    expect(ctx.req.notes).toContain(`Same address as on ${from}.`);
    expect(ctx.req.notes).toContain(NOTES.SILENT_REUSE({ chains: from }));
  });

  it('C-188 A-26 §9.5 stated chain without a DB2 row is also a silent reuse', async () => {
    const ctx = ctxD({ balances: usdc('100', '0', '0') });
    const a = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '5', a, SEPOLIA)]);
    const i = asI(plan[0]);
    expect(i.chain_id).toBe(SEPOLIA);
    expect([BASE, ARB]).toContain(i.reused_from_chain_id);
    expect(ctx.repos.db3.get(a)?.reused_from_chain_id).toBe(i.reused_from_chain_id);
    expect(ctx.repos.db2.findByAddress(ARADHYA_CS)).toHaveLength(2);
    expect(ctx.req.notes.some((n) => n.startsWith('Same address as on '))).toBe(true);
  });

  it('C-188 §9.5 chain with a DB2 row → no reuse, no note, DB3 reused_from_chain_id stays null', async () => {
    const ctx = ctxD({ balances: usdc('0', '100', '0') });
    const a = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '5', a, BASE)]);
    expect(asI(plan[0]).reused_from_chain_id).toBeNull();
    expect(ctx.repos.db3.get(a)?.reused_from_chain_id).toBeNull();
    expect(ctx.req.notes).toEqual([]);
  });

  it('C-188 §9.5 recipients pinned by ENS are never reused on another chain', async () => {
    const ctx = ctxD({ balances: usdc('100', '0', '0') });
    // the ENS name's address also happens to be a saved contact on Base/Arbitrum
    const r = addRecipient(ctx, {
      name: 'Aradhya',
      ens_name: 'aradhya.eth',
      address: ARADHYA_CS,
      source: 'ens',
      pinned_chain_id: SEPOLIA,
      ens_chain_ids: [SEPOLIA],
    });
    const plan = await runOk(ctx, [iPay(ctx, '5', r)]);
    expect(asI(plan[0])).toMatchObject({ chain_id: SEPOLIA, reused_from_chain_id: null });
    expect(ctx.repos.db3.get(r)?.reused_from_chain_id).toBeNull();
    expect(ctx.req.notes.some((n) => n.startsWith('Same address as on '))).toBe(false);
  });

  it('C-211 §10.3 rule 5: non-contact, nothing qualifies → largest spendable is the target and the shortfall is bridged', async () => {
    const ctx = ctxD({ balances: usdc('30', '40', '20') });
    const r = addRecipient(ctx, { name: null, address: STRANGER_CS, source: 'user' });
    const plan = await runOk(ctx, [iPay(ctx, '50', r)]);
    expect(asJ(plan[0])).toMatchObject({ source_chain_id: SEPOLIA, dest_chain_id: BASE });
    expect(amountOf(ctx, asJ(plan[0]).amount)).toBe('10.2');
    expect(asI(plan[1])).toMatchObject({ chain_id: BASE, depends_on: [0] });
  });

  it('C-211 §10.3 rule 4/5: contact — rule 4 extends to chains beyond the DB2 rows before the target is chosen', async () => {
    // need 50; Base 30, Arbitrum 45 (Aradhya's chains), Sepolia 49 → extended set's largest is Sepolia
    const ctx = ctxD({ balances: usdc('49', '30', '45') });
    const a = addAradhya(ctx);
    const plan = await runOk(ctx, [iPay(ctx, '50', a)]);
    expect(asI(plan[plan.length - 1]).chain_id).toBe(SEPOLIA);
  });
});

describe('§10.2 / §10.5 group expansion and ordering', () => {
  it('C-204 C-220 E4 §10.2 group → one i per selected member, alphabetical by subname, same amount placeholder, group chain', async () => {
    const ctx = ctxD({ balances: usdc('0', '100', '0') });
    const { group, members } = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [
        { subname: 'bob.iitr.eth', address: BOB_CS },
        { subname: 'alice.iitr.eth', address: ALICE_CS },
      ],
    });
    const a = addAmount(ctx, '10');
    const plan = await runOk(ctx, [pay(ctx, 'i', a, group, BASE)]);
    expect(plan).toEqual([
      {
        intent_id: 'i',
        step: 0,
        depends_on: [],
        token: 'USDC',
        chain_id: BASE,
        amount: a,
        recipient: members['alice.iitr.eth'],
        reused_from_chain_id: null,
      },
      {
        intent_id: 'i',
        step: 1,
        depends_on: [],
        token: 'USDC',
        chain_id: BASE,
        amount: a,
        recipient: members['bob.iitr.eth'],
        reused_from_chain_id: null,
      },
    ]);
  });

  it('C-204 C-220 §10.2 §10.5 group stays at the group payment position among other payments', async () => {
    const ctx = ctxD({ balances: usdc('0', '200', '0') });
    const mi = addMihir(ctx);
    const { group, members } = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [
        { subname: 'carol.iitr.eth', address: CAROL_CS },
        { subname: 'alice.iitr.eth', address: ALICE_CS },
      ],
    });
    const a = addAradhya(ctx);
    const ga = addAmount(ctx, '10');
    const plan = await runOk(ctx, [iPay(ctx, '5', mi, BASE), pay(ctx, 'i', ga, group, BASE), iPay(ctx, '7', a, BASE)]);
    expect(plan.map((p) => asI(p).recipient)).toEqual([mi, members['alice.iitr.eth'], members['carol.iitr.eth'], a]);
  });

  it(
    'C-204 §10.2 group members' + "' total need is assigned together: 3 × 40 on Base 100 → a bridge for the shortfall",
    async () => {
      const ctx = ctxD({ balances: usdc('0', '100', '100') });
      const { group } = addGroup(ctx, {
        parent: 'iitr.eth',
        chain_id: BASE,
        members: [
          { subname: 'a.iitr.eth', address: ALICE_CS },
          { subname: 'b.iitr.eth', address: BOB_CS },
          { subname: 'c.iitr.eth', address: CAROL_CS },
        ],
      });
      const a = addAmount(ctx, '40');
      const plan = await runOk(ctx, [pay(ctx, 'i', a, group, BASE)]);
      expect(plan.map((p) => p.intent_id)).toEqual(['j', 'i', 'i', 'i']);
      expect(amountOf(ctx, asJ(plan[0]).amount)).toBe('20.4');
      expect(asI(plan[1]).depends_on).toEqual([0]);
      expect(asJ(plan[0]).funds_steps).toEqual([1, 2, 3]);
    },
  );

  it('C-221 C-223 §10.5 rules 4 and 6: i depends on j steps for its chain; l has no depends_on', async () => {
    const ctx = ctxD({ actions: ['i', 'l'], balances: usdc('0', '30', '60') });
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7' });
    const a = addAradhya(ctx);
    const mi = addMihir(ctx);
    const amt = addAmount(ctx, '50');
    const plan = await runOk(ctx, [pay(ctx, 'i', amt, a, BASE), pay(ctx, 'l', null, mi)]);
    expect(plan.map((p) => p.intent_id)).toEqual(['j', 'i', 'l']);
    expect('depends_on' in asL(plan[2])).toBe(false);
    expect(asI(plan[1]).depends_on).toEqual([0]);
  });
});

describe('§17.2 follow-ups', () => {
  it('C-418 §17.2 step 4: "unstated" chain uses the previous chain as if stated (even when another chain is larger)', async () => {
    const ctx = ctxD({ balances: usdc('0', '50', '500') });
    const prev = addFollowup(ctx, { name: 'Aradhya', address: ARADHYA_CS, last_chain_id: BASE });
    const plan = await runOk(ctx, [iPay(ctx, '5', prev)]);
    expect(asI(plan[0])).toMatchObject({ chain_id: BASE, recipient: prev, reused_from_chain_id: null });
  });

  it('C-418 §17.2 step 4: previous chain without a DB2 row for a contact is a silent reuse (same as a stated chain)', async () => {
    const ctx = ctxD({ balances: usdc('50', '0', '0') });
    const prev = addFollowup(ctx, { name: 'Aradhya', address: ARADHYA_CS, last_chain_id: SEPOLIA });
    const plan = await runOk(ctx, [iPay(ctx, '5', prev)]);
    const i = asI(plan[0]);
    expect(i.chain_id).toBe(SEPOLIA);
    expect([BASE, ARB]).toContain(i.reused_from_chain_id);
  });

  it('C-418 §17.2 step 4: null last chain falls through to the §10.3 rules (user address → every allowed chain)', async () => {
    const ctx = ctxD({ balances: usdc('90', '50', '10') });
    const prev = addFollowup(ctx, {
      name: 'Stranger',
      address: STRANGER_CS,
      last_chain_id: null as unknown as ChainId,
      source: 'user',
    });
    const plan = await runOk(ctx, [iPay(ctx, '5', prev)]);
    expect(asI(plan[0]).chain_id).toBe(SEPOLIA);
  });

  it('C-418 §17.2 step 4: null last chain for a contact follows candidates by DB2 chains', async () => {
    const ctx = ctxD({ balances: usdc('500', '40', '60') });
    const prev = addFollowup(ctx, { name: 'Aradhya', address: ARADHYA_CS, last_chain_id: null as unknown as ChainId });
    const plan = await runOk(ctx, [iPay(ctx, '5', prev)]);
    expect(asI(plan[0]).chain_id).toBe(ARB);
  });

  it('C-418 §17.2 step 4: previous chain differing from a pinned (relative) amount chain → CHAIN_CONFLICT', async () => {
    const ctx = ctxD({ balances: usdc('0', '100', '100') });
    const prev = addFollowup(ctx, { name: 'Aradhya', address: ARADHYA_CS, last_chain_id: BASE });
    const res = await run(ctx, [iPay(ctx, '5', prev, 'unstated', { pinned: ARB })]);
    expectError(res, 'CHAIN_CONFLICT', { name: 'Aradhya', chain: 'Arbitrum Sepolia', other: 'Base Sepolia' });
  });

  it('C-419 §17.2 step 7: a follow-up plan carries the note "Recipient and chain from your last payment."', async () => {
    const ctx = ctxD({ balances: usdc('0', '50', '0') });
    const prev = addFollowup(ctx, { name: 'Aradhya', address: ARADHYA_CS, last_chain_id: BASE });
    await runOk(ctx, [iPay(ctx, '5', prev)]);
    expect(ctx.req.notes).toContain('Recipient and chain from your last payment.');
  });

  it('C-419 §17.2 step 7: a normal payment has no follow-up note', async () => {
    const ctx = ctxD({ balances: usdc('0', '50', '0') });
    const r = addAradhya(ctx);
    await runOk(ctx, [iPay(ctx, '5', r)]);
    expect(ctx.req.notes).not.toContain('Recipient and chain from your last payment.');
  });
});

describe('§19 worked examples (plan objects asserted exactly, each valid against the internal plan schema)', () => {
  it('C-432 E1: 50 USDC to Aradhya, Base 80 / Arbitrum 60 → one i on Base Sepolia, no bridges', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '60') });
    const r = addAradhya(ctx);
    const p = iPay(ctx, '50', r);
    const plan = await runOk(ctx, [p]);
    expect(plan).toEqual([
      {
        intent_id: 'i',
        step: 0,
        depends_on: [],
        token: 'USDC',
        chain_id: 84532,
        amount: p.amount,
        recipient: r,
        reused_from_chain_id: null,
      },
    ]);
    expect(ctx.req.state).toBe('PLANNED');
  });

  it('C-433 E2: 50 USDC to Aradhya on base, Base 30 / Arbitrum 60 → j 20.4 Arbitrum → Base, then i', async () => {
    const ctx = ctxD({ balances: usdc('0', '30', '60') });
    const r = addAradhya(ctx);
    const p = iPay(ctx, '50', r, BASE);
    const plan = await runOk(ctx, [p]);
    const j = asJ(plan[0]);
    expect(amountOf(ctx, j.amount)).toBe('20.4');
    expect(plan).toEqual([
      {
        intent_id: 'j',
        step: 0,
        token: 'USDC',
        source_chain_id: ARB,
        dest_chain_id: BASE,
        amount: j.amount,
        deliverable_base_units: '20000000',
        receiver: 'self',
        funds_steps: [1],
      },
      {
        intent_id: 'i',
        step: 1,
        depends_on: [0],
        token: 'USDC',
        chain_id: BASE,
        amount: p.amount,
        recipient: r,
        reused_from_chain_id: null,
      },
    ]);
  });

  it('C-434 E3: 40 to Aradhya on base and 20 to Mihir on arbitrum, Arbitrum 50 / Base 30 → j 10.2, i, i', async () => {
    const ctx = ctxD({ balances: usdc('0', '30', '50') });
    const a = addAradhya(ctx);
    const mi = addMihir(ctx);
    const p1 = iPay(ctx, '40', a, BASE);
    const p2 = iPay(ctx, '20', mi, ARB);
    const plan = await runOk(ctx, [p1, p2]);
    const j = asJ(plan[0]);
    expect(amountOf(ctx, j.amount)).toBe('10.2');
    expect(ctx.repos.db1.get(j.amount)).toMatchObject({ source: 'derived', origin: 'bridge_padded' });
    expect(plan).toEqual([
      {
        intent_id: 'j',
        step: 0,
        token: 'USDC',
        source_chain_id: 421614,
        dest_chain_id: 84532,
        amount: j.amount,
        deliverable_base_units: '10000000',
        receiver: 'self',
        funds_steps: [1],
      },
      {
        intent_id: 'i',
        step: 1,
        depends_on: [0],
        token: 'USDC',
        chain_id: 84532,
        amount: p1.amount,
        recipient: a,
        reused_from_chain_id: null,
      },
      {
        intent_id: 'i',
        step: 2,
        depends_on: [],
        token: 'USDC',
        chain_id: 421614,
        amount: p2.amount,
        recipient: mi,
        reused_from_chain_id: null,
      },
    ]);
  });

  it('C-435 E4: 10 USDC to the iitr.eth group on Base → two i intents (alice, bob), same amount placeholder', async () => {
    const ctx = ctxD({ balances: usdc('0', '100', '0') });
    const { group, members } = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [
        { subname: 'alice.iitr.eth', address: ALICE_CS },
        { subname: 'bob.iitr.eth', address: BOB_CS },
      ],
    });
    const a = addAmount(ctx, '10');
    const plan = await runOk(ctx, [pay(ctx, 'i', a, group, 84532)]);
    expect(plan.map((x) => [asI(x).step, asI(x).recipient, asI(x).chain_id, asI(x).amount])).toEqual([
      [0, members['alice.iitr.eth'], 84532, a],
      [1, members['bob.iitr.eth'], 84532, a],
    ]);
  });

  it('C-436 E5: "Send 5 more" after E2 → recipient and chain 84532 from the last payment; follow-up note', async () => {
    const ctx = ctxD({ balances: usdc('0', '30', '60') });
    const prev = addFollowup(ctx, { name: 'Aradhya', address: ARADHYA_CS, last_chain_id: 84532 });
    const p = iPay(ctx, '5', prev);
    const plan = await runOk(ctx, [p]);
    expect(plan).toEqual([
      {
        intent_id: 'i',
        step: 0,
        depends_on: [],
        token: 'USDC',
        chain_id: 84532,
        amount: p.amount,
        recipient: prev,
        reused_from_chain_id: null,
      },
    ]);
    expect(ctx.req.notes).toEqual(['Recipient and chain from your last payment.']);
  });

  it('C-437 E6: "pay mihir 10 usdc every friday for 8 weeks" → one k on Base; caps 10 and 80; cron 0 10 * * 5; expires 23:59:59 IST on the last occurrence date (Fri 2026-12-25; §19 text says 12-31, conflicting with §10.6 derived 8)', async () => {
    const { ctx, payment, recipient } = kSetup({
      clause: 'pay mihir 10 usdc every friday for 8 weeks',
      balances: usdc('0', '100', '90'),
    });
    const plan = await runOk(ctx, [payment]);
    expect(plan).toHaveLength(1);
    const k = asK(plan[0]);
    expect(k).toMatchObject({
      intent_id: 'k',
      step: 0,
      depends_on: [],
      token: 'USDC',
      chain_id: 84532,
      recipient,
      amount_per_payment: payment.amount,
      schedule: {
        frequency: 'weekly',
        interval: 1,
        days_of_week: ['FRI'],
        day_of_month: null,
        time_of_day: '10:00',
        timezone: 'Asia/Kolkata',
        start_date: '2026-11-05',
        end: { type: 'on_date', date: '2026-12-31' },
      },
      limits: { expires_at: '2026-12-25T18:29:59Z' },
      cre_job: { trigger: 'cron', cron: '0 10 * * 5', timezone: 'Asia/Kolkata', interval: 1 },
    });
    expect(k.autopay_id).toMatch(/^ap_[0-9a-f]{12}$/);
    expect(new Date(k.schedule.first_occurrence).getTime()).toBe(new Date('2026-11-06T04:30:00Z').getTime());
    expect(amountOf(ctx, k.limits.per_period_cap)).toBe('10');
    expect(amountOf(ctx, k.limits.total_cap)).toBe('80');
    expect(Object.keys(k).sort()).toEqual(
      [
        'amount_per_payment',
        'autopay_id',
        'chain_id',
        'cre_job',
        'depends_on',
        'intent_id',
        'limits',
        'recipient',
        'schedule',
        'step',
        'token',
      ].sort(),
    );
  });

  it('C-438 E7: "stop paying mihir" with one active autopay → l with autopay_id, chain and delegate from DB7', async () => {
    const ctx = ctxD({ actions: ['l'], balances: usdc('0', '10', '10') });
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7' });
    const mi = addMihir(ctx);
    const plan = await runOk(ctx, [pay(ctx, 'l', null, mi)]);
    expect(plan).toEqual([
      {
        intent_id: 'l',
        step: 0,
        autopay_id: 'ap_0000000000f7',
        chain_id: BASE,
        delegate_address: DELEGATE_CS,
        recipient: mi,
        refund_remaining: true,
      },
    ]);
  });
});

describe('S9 request-level behaviour', () => {
  it('C-218 §10.5 success sets req.plan, state PLANNED, clears step_state.s9 and returns continue', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    const r = addAradhya(ctx);
    expect(await run(ctx, [iPay(ctx, '5', r)])).toEqual({ kind: 'continue' });
    expect(ctx.req.state).toBe('PLANNED');
    expect(ctx.req.step_state.s9).toBeUndefined();
    expectValidPlan(ctx);
    expect(planOf(ctx)).toHaveLength(1);
  });

  it('C-203 §10.1 an i-only plan mints nothing in DB1 beyond the amounts S3 already created', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    const r = addAradhya(ctx);
    const p = iPay(ctx, '5', r);
    const before = db1Count(ctx);
    await runOk(ctx, [p]);
    expect(db1Count(ctx)).toBe(before);
  });

  it('S9 exports a step entry with an answer handler', () => {
    expect(typeof s9.step).toBe('function');
    expect(typeof s9.onAnswer).toBe('function');
  });
});
