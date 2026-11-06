// Lane D tester: S10 validate — §11 V-01…V-15, §11.1 INTERNAL_ERROR logging, §11.3 daily limit incl. DB6 rows around
// local midnight, §13.4 Q_GROUP_OVER_LIMIT, §15 LIMIT_PER_TX / LIMIT_DAILY messages.
import { describe, expect, it, vi } from 'vitest';
import { CHIPS, ERROR_MESSAGE, NOTES, REPLY } from '../../../src/contracts/catalog.js';
import type { Address, AddressPh, AmountPh, InternalIntent, Schedule } from '../../../src/contracts/types.js';
import { s10 } from '../../../src/pipeline/s10-validate.js';
import { buildSummary } from '../../../src/messages/summary.js';
import type { TestContext } from '../../fakes/context.js';
import { seedContact } from '../../fakes/repos.js';
import {
  ALICE_CS,
  ARADHYA_CS,
  ARB,
  BASE,
  BOB_CS,
  DOC_ADDR_CS,
  SEPOLIA,
  WALLET_CS,
  ZERO_ADDRESS,
  addAmount,
  addAradhya,
  addAutopay,
  addGroup,
  addMihir,
  addRecipient,
  ctxD,
  db6Row,
  expectError,
  expectQuestion,
  expectRuleLogged,
  mintAmount,
  pay,
  planI,
  planJ,
  planK,
  planL,
  setLimits,
  weekly,
} from './helpers.js';
import { chip, text, usdc } from './s9-helpers.js';

vi.mock('../../../src/amounts/parse.js', async () => {
  const m = await import('./parse-mock.js');
  return { parseAmountText: (t: string) => m.fakeParseAmountText(t) };
});

const OTHER_SESSION = 'ses_00000000ffff';

interface Fixture {
  ctx: TestContext;
  r: AddressPh;
}

/** A context whose Base balance is 500 USDC, with Aradhya as recipient. */
function base(extra: Parameters<typeof ctxD>[0] = {}): Fixture {
  const ctx = ctxD({ balances: usdc('0', '500', '0'), ...extra });
  return { ctx, r: addAradhya(ctx) };
}

async function validate(ctx: TestContext, plan: InternalIntent[]) {
  ctx.req.plan = plan;
  return s10.step(ctx);
}

function iOf(ctx: TestContext, amount: string, r: AddressPh, step = 0): InternalIntent {
  return planI(step, mintAmount(ctx, amount), r, BASE);
}

function expectInternal(ctx: TestContext, res: Awaited<ReturnType<typeof validate>>, rule: string): void {
  const msg = expectError(res, 'INTERNAL_ERROR');
  expect(msg).toBe('Something went wrong preparing this. Nothing was sent.');
  expectRuleLogged(ctx, rule);
}

describe('C-450 §20.1 validate: S10 happy path', () => {
  it('§8.12 a valid plan → continue, state VALIDATED, one info log', async () => {
    const { ctx, r } = base();
    expect(await validate(ctx, [iOf(ctx, '5', r)])).toEqual({ kind: 'continue' });
    expect(ctx.req.state).toBe('VALIDATED');
    expect(ctx.log.lines.some((l) => l.level === 'info' && l.event === 'validated')).toBe(true);
  });

  it('§8.12 no plan on the request → INTERNAL_ERROR (V-01)', async () => {
    const { ctx } = base();
    delete ctx.req.plan;
    expectInternal(ctx, await s10.step(ctx), 'V-01');
  });
});

describe('§11.1 structural rules', () => {
  it('C-246 §11 V-01 plan violating the internal schema (unknown token) → INTERNAL_ERROR, rule logged', async () => {
    const { ctx, r } = base();
    const it = { ...iOf(ctx, '5', r), token: 'DAI' } as unknown as InternalIntent;
    expectInternal(ctx, await validate(ctx, [it]), 'V-01');
  });

  it('C-246 §11 V-01 extra field on an intent breaks the schema (additionalProperties)', async () => {
    const { ctx, r } = base();
    const it = { ...iOf(ctx, '5', r), name: 'Aradhya' } as unknown as InternalIntent;
    expectInternal(ctx, await validate(ctx, [it]), 'V-01');
  });

  it('C-247 §11 V-02 amount placeholder minted for another session → INTERNAL_ERROR', async () => {
    const { ctx, r } = base();
    const foreign = mintAmount(ctx, '5', 'USDC', { session_id: OTHER_SESSION });
    expectInternal(ctx, await validate(ctx, [planI(0, foreign, r, BASE)]), 'V-02');
  });

  it('C-247 §11 V-02 address placeholder of another session → INTERNAL_ERROR', async () => {
    const { ctx } = base();
    const foreign = ctx.repos.db3.mint({
      session_id: OTHER_SESSION as never,
      request_id: ctx.req.request_id,
      kind: 'single',
      name: 'X',
      address: ALICE_CS,
      ens_name: null,
      chain_id: null,
      group_placeholder: null,
      source: 'contact',
    }) as AddressPh;
    expectInternal(ctx, await validate(ctx, [iOf(ctx, '5', foreign)]), 'V-02');
  });

  it('C-247 §11 V-02 placeholder that does not exist at all → INTERNAL_ERROR', async () => {
    const { ctx, r } = base();
    const it = planI(0, 'amount_deadbeef' as AmountPh, r, BASE);
    expectInternal(ctx, await validate(ctx, [it]), 'V-02');
  });

  it('C-248 §11 V-03 steps must be 0…n-1 without gaps → INTERNAL_ERROR', async () => {
    const { ctx, r } = base();
    expectInternal(ctx, await validate(ctx, [iOf(ctx, '5', r, 1)]), 'V-03');
  });

  it('C-248 §11 V-03 depends_on pointing to a later step / a non-j step → INTERNAL_ERROR', async () => {
    const { ctx, r } = base();
    const first = planI(0, mintAmount(ctx, '5'), r, BASE, { depends_on: [1] });
    expectInternal(ctx, await validate(ctx, [first, iOf(ctx, '5', r, 1)]), 'V-03');
    const ctx2 = base().ctx;
    const r2 = addAradhya(ctx2);
    const a = planI(0, mintAmount(ctx2, '5'), r2, BASE);
    const b = planI(1, mintAmount(ctx2, '5'), r2, BASE, { depends_on: [0] });
    expectInternal(ctx2, await validate(ctx2, [a, b]), 'V-03');
  });

  it('C-248 §11 V-03 j.funds_steps must point to later steps', async () => {
    const { ctx, r } = base({ balances: usdc('0', '30', '60') });
    const j = planJ(ctx, 0, ARB, BASE, '20.4', '20', [0]);
    const i = planI(1, mintAmount(ctx, '50'), r, BASE, { depends_on: [0] });
    expectInternal(ctx, await validate(ctx, [j, i]), 'V-03');
  });

  it('C-248 §11 V-03 a correct j → i chain passes', async () => {
    const { ctx, r } = base({ balances: usdc('0', '30', '60') });
    const j = planJ(ctx, 0, ARB, BASE, '20.4', '20', [1]);
    const i = planI(1, mintAmount(ctx, '50'), r, BASE, { depends_on: [0] });
    expect(await validate(ctx, [j, i])).toEqual({ kind: 'continue' });
  });

  it('C-249 §11 V-04 j with source chain = destination chain → INTERNAL_ERROR', async () => {
    const { ctx, r } = base({ balances: usdc('0', '100', '0') });
    const j = planJ(ctx, 0, BASE, BASE, '20.4', '20', [1]);
    const i = planI(1, mintAmount(ctx, '5'), r, BASE, { depends_on: [0] });
    expectInternal(ctx, await validate(ctx, [j, i]), 'V-04');
  });

  it('C-250 §11 V-05 chain not in allowed_chain_ids → CHAIN_NOT_ALLOWED with the chain name', async () => {
    const { ctx, r } = base();
    setLimits(ctx, { allowed_chain_ids: [SEPOLIA, ARB] });
    const msg = expectError(await validate(ctx, [iOf(ctx, '5', r)]), 'CHAIN_NOT_ALLOWED', { chain: 'Base Sepolia' });
    expect(msg).toBe("Base Sepolia isn't in your allowed chains (Settings).");
  });

  it('C-250 §11 V-05 a j destination chain outside the allowed list → CHAIN_NOT_ALLOWED', async () => {
    const { ctx, r } = base({ balances: usdc('0', '30', '60') });
    setLimits(ctx, { allowed_chain_ids: [SEPOLIA, ARB] });
    const j = planJ(ctx, 0, ARB, BASE, '20.4', '20', [1]);
    const i = planI(1, mintAmount(ctx, '50'), r, BASE, { depends_on: [0] });
    expectError(await validate(ctx, [j, i]), 'CHAIN_NOT_ALLOWED', { chain: 'Base Sepolia' });
  });

  it('C-250 §11 V-05 chain with DB4 status not ok → BALANCES_UNAVAILABLE', async () => {
    const { ctx, r } = base();
    ctx.repos.db4.markUnavailable(BASE, 'USDC', '2026-11-05T17:29:00Z');
    const msg = expectError(await validate(ctx, [iOf(ctx, '5', r)]), 'BALANCES_UNAVAILABLE', {
      chains: 'Base Sepolia',
    });
    expect(msg).toBe("I can't read your balances on Base Sepolia right now. Try again in a moment.");
  });

  it('C-251 §11 V-06 zero amount → INTERNAL_ERROR', async () => {
    const { ctx, r } = base();
    expectInternal(ctx, await validate(ctx, [iOf(ctx, '0', r)]), 'V-06');
  });

  it('C-251 §11 V-06 more decimals than the token has (7 for USDC) → INTERNAL_ERROR', async () => {
    const { ctx, r } = base();
    expectInternal(ctx, await validate(ctx, [iOf(ctx, '1.1234567', r)]), 'V-06');
  });

  it('C-251 §11 V-06 exactly 6 decimals for USDC and 18 for ETH pass', async () => {
    const { ctx, r } = base();
    expect(await validate(ctx, [iOf(ctx, '1.123456', r)])).toEqual({ kind: 'continue' });
    const c2 = base();
    const eth = planI(0, mintAmount(c2.ctx, '0.000000000000000001', 'ETH'), c2.r, BASE, { token: 'ETH' });
    expect(await validate(c2.ctx, [eth])).toEqual({ kind: 'continue' });
  });

  it('C-252 §11 V-07 recipient = wallet address → SELF_PAYMENT', async () => {
    const { ctx } = base();
    const self = addRecipient(ctx, { name: 'Me', address: WALLET_CS, dbOnly: true });
    const msg = expectError(await validate(ctx, [iOf(ctx, '5', self)]), 'SELF_PAYMENT');
    expect(msg).toBe("That's your own address. Moving funds between your own chains isn't a payment I can make.");
  });

  it('C-252 §11 V-07 recipient = zero address → SELF_PAYMENT', async () => {
    const { ctx } = base();
    const z = addRecipient(ctx, { name: 'Zero', address: ZERO_ADDRESS, dbOnly: true });
    expectError(await validate(ctx, [iOf(ctx, '5', z)]), 'SELF_PAYMENT');
  });

  it('C-252 §11 V-07 the wallet address in lower case is still own address', async () => {
    const { ctx } = base();
    const self = addRecipient(ctx, { name: 'Me', address: WALLET_CS.toLowerCase() as Address, dbOnly: true });
    expectError(await validate(ctx, [iOf(ctx, '5', self)]), 'SELF_PAYMENT');
  });

  it('C-253 §11 V-08 untrusted amount with confirmed=0 → INTERNAL_ERROR', async () => {
    const { ctx, r } = base();
    const a = mintAmount(ctx, '120', 'USDC', { source: 'untrusted', origin: 'document', confirmed: false });
    expectInternal(ctx, await validate(ctx, [planI(0, a, r, BASE)]), 'V-08');
  });

  it('C-253 §11 V-08 untrusted amount with confirmed=1 passes', async () => {
    const { ctx, r } = base();
    const a = mintAmount(ctx, '120', 'USDC', { source: 'untrusted', origin: 'document', confirmed: true });
    setLimits(ctx, { per_tx_max: { USDC: '200', ETH: '0.05' } });
    expect(await validate(ctx, [planI(0, a, r, BASE)])).toEqual({ kind: 'continue' });
  });

  it('C-253 §16.1 P7 V-08 k with an untrusted amount → UNTRUSTED_IN_AUTOPAY', async () => {
    const { ctx, r } = base();
    const a = mintAmount(ctx, '10', 'USDC', { source: 'untrusted', origin: 'document', confirmed: true });
    const k = planK(ctx, 0, r, BASE, { amountPh: a });
    const msg = expectError(await validate(ctx, [k]), 'UNTRUSTED_IN_AUTOPAY');
    expect(msg).toBe('Repeating payments can only use amounts and addresses you typed or saved yourself.');
  });

  it('C-253 §16.1 P7 V-08 k to an untrusted address that has NO DB2 row → UNTRUSTED_IN_AUTOPAY', async () => {
    const { ctx } = base();
    const doc = addRecipient(ctx, { name: null, address: DOC_ADDR_CS, source: 'untrusted' });
    expectError(await validate(ctx, [planK(ctx, 0, doc, BASE)]), 'UNTRUSTED_IN_AUTOPAY');
  });

  it('C-253 §16.1 P7 V-08 k to a just-confirmed content address (DB2 row now exists, DB3 source untrusted) → still UNTRUSTED_IN_AUTOPAY', async () => {
    const { ctx } = base();
    const doc = addRecipient(ctx, { name: 'Vendor', address: DOC_ADDR_CS, source: 'untrusted' });
    seedContact(ctx.repos, 'Vendor', DOC_ADDR_CS, [BASE]);
    expect(ctx.repos.db2.findByAddress(DOC_ADDR_CS).length).toBeGreaterThan(0);
    expectError(await validate(ctx, [planK(ctx, 0, doc, BASE)]), 'UNTRUSTED_IN_AUTOPAY');
  });

  it('C-253 §16.1 P7 V-08 k to a recipient with DB3 source=contact passes', async () => {
    const { ctx, r } = base();
    expect(await validate(ctx, [planK(ctx, 0, r, BASE)])).toEqual({ kind: 'continue' });
  });

  it('C-253 §16.1 V-08 an ENS-sourced recipient (not contact) in a k is not UNTRUSTED_IN_AUTOPAY (only untrusted is blocked)', async () => {
    const { ctx } = base();
    const ens = addRecipient(ctx, { name: 'riya.eth', address: ALICE_CS, source: 'ens', ens_name: 'riya.eth' });
    const r = await validate(ctx, [planK(ctx, 0, ens, BASE)]);
    expect(r.kind === 'error' && r.code === 'UNTRUSTED_IN_AUTOPAY').toBe(false);
  });

  it('C-254 §11 V-09 l whose DB7 row is missing → NO_ACTIVE_AUTOPAY with the recipient name', async () => {
    const ctx = ctxD({ actions: ['l'] });
    const mi = addMihir(ctx);
    const msg = expectError(await validate(ctx, [planL(0, mi, 'ap_0000000000aa')]), 'NO_ACTIVE_AUTOPAY', {
      name: 'Mihir',
    });
    expect(msg).toBe("There's no active repeating payment to Mihir.");
  });

  it('C-254 §11 V-09 l whose DB7 status is not active → NO_ACTIVE_AUTOPAY', async () => {
    const ctx = ctxD({ actions: ['l'] });
    const mi = addMihir(ctx);
    for (const status of ['pending', 'cancelled'] as const) {
      addAutopay(ctx, { autopay_id: `ap_00000000000${status === 'pending' ? 1 : 2}`, status });
    }
    expectError(await validate(ctx, [planL(0, mi, 'ap_000000000001')]), 'NO_ACTIVE_AUTOPAY');
    expectError(await validate(ctx, [planL(0, mi, 'ap_000000000002')]), 'NO_ACTIVE_AUTOPAY');
  });

  it('C-254 §11 V-09 l active but without delegate_address → NO_ACTIVE_AUTOPAY', async () => {
    const ctx = ctxD({ actions: ['l'] });
    const mi = addMihir(ctx);
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7', status: 'active', delegate: null });
    expectError(await validate(ctx, [planL(0, mi, 'ap_0000000000f7')]), 'NO_ACTIVE_AUTOPAY');
  });

  it('C-254 §11 V-09 l active with delegate passes (no token moved, no funding checks)', async () => {
    const ctx = ctxD({ actions: ['l'] });
    const mi = addMihir(ctx);
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7' });
    expect(await validate(ctx, [planL(0, mi, 'ap_0000000000f7')])).toEqual({ kind: 'continue' });
  });
});

describe('§11.1 INTERNAL_ERROR (C-261)', () => {
  it('C-261 §11.1 logs the rule id (letters-first label), never values; user message is the catalog text', async () => {
    const { ctx, r } = base();
    const res = await validate(ctx, [iOf(ctx, '0', r)]);
    expect(res).toEqual({ kind: 'error', code: 'INTERNAL_ERROR' });
    const line = ctx.log.lines.find((l) => l.rule_id === 'V-06');
    expect(line).toBeDefined();
    expect(line?.level).toBe('error');
    expect(line?.event).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
    const dump = JSON.stringify(ctx.log.lines);
    expect(dump).not.toContain(ARADHYA_CS);
    expect(res.kind === 'error' && res.final_state).toBeFalsy(); // default final state FAILED (runner)
    expect(ERROR_MESSAGE.INTERNAL_ERROR({})).toBe('Something went wrong preparing this. Nothing was sent.');
    expect(ctx.req.state).not.toBe('VALIDATED');
  });
});

describe('§11.2 funding rules', () => {
  it('C-255 §11 V-10 need > spendable → INSUFFICIENT_FUNDS with the §15 template (SQ-08)', async () => {
    const { ctx, r } = base({ balances: usdc('0', '10', '5') });
    const res = await validate(ctx, [iOf(ctx, '50', r)]);
    const msg = expectError(res, 'INSUFFICIENT_FUNDS', { token: 'USDC', need: '50', have: '15' });
    expect(msg).toBe(
      "You don't have enough USDC: you need 50, and can use 15 across Sepolia, Base Sepolia and Arbitrum Sepolia.",
    );
  });

  it('C-255 §11 V-10 need == spendable passes', async () => {
    const { ctx, r } = base({ balances: usdc('0', '50', '0') });
    expect(await validate(ctx, [iOf(ctx, '50', r)])).toEqual({ kind: 'continue' });
  });

  it('C-255 §11 V-10 bridged-in credit and bridged-out debit are applied per chain', async () => {
    const ok = base({ balances: usdc('0', '30', '60') });
    const j = planJ(ok.ctx, 0, ARB, BASE, '20.4', '20', [1]);
    const i = planI(1, mintAmount(ok.ctx, '50'), ok.r, BASE, { depends_on: [0] });
    expect(await validate(ok.ctx, [j, i])).toEqual({ kind: 'continue' });
    const bad = base({ balances: usdc('0', '30', '60') });
    const j2 = planJ(bad.ctx, 0, ARB, BASE, '10.2', '10', [1]);
    const i2 = planI(1, mintAmount(bad.ctx, '50'), bad.r, BASE, { depends_on: [0] });
    expectError(await validate(bad.ctx, [j2, i2]), 'INSUFFICIENT_FUNDS', { token: 'USDC' });
  });

  it('C-255 §11 V-10 a pending DB6 row of the last 10 minutes lowers spendable', async () => {
    const { ctx, r } = base({ balances: usdc('0', '50', '0') });
    ctx.repos.db6.insertMany([db6Row({ kind: 'payment', amount: '10', created_at: '2026-11-05T17:25:00.000Z' })]);
    expectError(await validate(ctx, [iOf(ctx, '45', r)]), 'INSUFFICIENT_FUNDS');
  });

  it('C-255 §11 V-10 ETH payment checked against ETH spendable (after gas reserve)', async () => {
    const { ctx, r } = base({ balances: { [BASE]: { ETH: '0.03' } } });
    // reserve 0.002 → spendable 0.028
    const ok = planI(0, mintAmount(ctx, '0.028', 'ETH'), r, BASE, { token: 'ETH' });
    expect(await validate(ctx, [ok])).toEqual({ kind: 'continue' });
    const bad = planI(0, mintAmount(ctx, '0.029', 'ETH'), r, BASE, { token: 'ETH' });
    expectError(await validate(ctx, [bad]), 'INSUFFICIENT_FUNDS', { token: 'ETH' });
  });

  it('C-256 §11 V-11 raw ETH below the reserve on a touched chain → NO_GAS', async () => {
    const { ctx, r } = base({ balances: { ...usdc('0', '500', '0'), [BASE]: { ETH: '0.001', USDC: '500' } } });
    const msg = expectError(await validate(ctx, [iOf(ctx, '5', r)]), 'NO_GAS', {
      reserve: '0.002',
      chain: 'Base Sepolia',
    });
    expect(msg).toBe('You need at least 0.002 ETH on Base Sepolia for network fees.');
  });

  it('C-256 §11 V-11 ETH exactly at the reserve passes; untouched chains are not checked', async () => {
    const { ctx, r } = base({
      balances: { ...usdc('0', '500', '0'), [BASE]: { ETH: '0.002', USDC: '500' }, [ARB]: { ETH: '0' } },
    });
    expect(await validate(ctx, [iOf(ctx, '5', r)])).toEqual({ kind: 'continue' });
  });

  it('C-256 §11 V-11 j source chain is a touched chain (needs gas)', async () => {
    const { ctx, r } = base({ balances: { ...usdc('0', '30', '60'), [ARB]: { ETH: '0', USDC: '60' } } });
    const j = planJ(ctx, 0, ARB, BASE, '20.4', '20', [1]);
    const i = planI(1, mintAmount(ctx, '50'), r, BASE, { depends_on: [0] });
    expectError(await validate(ctx, [j, i]), 'NO_GAS', { chain: 'Arbitrum Sepolia' });
  });

  function manyBridges(n: number): { ctx: TestContext; plan: InternalIntent[] } {
    const { ctx, r } = base({ balances: usdc('0', '0', '1000') });
    const plan: InternalIntent[] = [];
    for (let s = 0; s < n; s++) plan.push(planJ(ctx, s, ARB, BASE, '10.2', '10', [n]));
    plan.push(
      planI(n, mintAmount(ctx, String(10 * n)), r, BASE, { depends_on: Array.from({ length: n }, (_, s) => s) }),
    );
    return { ctx, plan };
  }

  it('C-257 §11 V-12 more bridges than max_bridges_per_request → LIMIT_BRIDGES', async () => {
    const { ctx, plan } = manyBridges(4);
    const msg = expectError(await validate(ctx, plan), 'LIMIT_BRIDGES', { n: '4', max: '3' });
    expect(msg).toBe('This needs 4 transfers between chains; your limit is 3.');
  });

  it('C-257 §11 V-12 exactly max bridges passes', async () => {
    const { ctx, plan } = manyBridges(3);
    expect(await validate(ctx, plan)).toEqual({ kind: 'continue' });
  });
});

describe('§11.3 per-intent limits', () => {
  it('C-258 C-384 §11 V-13 §15 i amount over per_tx_max → LIMIT_PER_TX with the catalog message', async () => {
    const { ctx, r } = base();
    const msg = expectError(await validate(ctx, [iOf(ctx, '101', r)]), 'LIMIT_PER_TX', {
      amount: '101',
      token: 'USDC',
      max: '100',
    });
    expect(msg).toBe('101 USDC is over your per-payment limit of 100.');
  });

  it('C-258 §11 V-13 amount equal to per_tx_max passes; ETH uses its own max', async () => {
    const { ctx, r } = base();
    expect(await validate(ctx, [iOf(ctx, '100', r)])).toEqual({ kind: 'continue' });
    const eth = planI(0, mintAmount(ctx, '0.06', 'ETH'), r, BASE, { token: 'ETH' });
    expectError(await validate(ctx, [eth]), 'LIMIT_PER_TX', { amount: '0.06', token: 'ETH', max: '0.05' });
  });

  it('C-258 §11 V-13 group members are checked one by one (60 + 60 passes, 101 each fails)', async () => {
    const { ctx } = base();
    const { members } = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [
        { subname: 'alice.iitr.eth', address: ALICE_CS },
        { subname: 'bob.iitr.eth', address: BOB_CS },
      ],
    });
    const a = mintAmount(ctx, '60');
    const plan = [
      planI(0, a, members['alice.iitr.eth'] as AddressPh, BASE),
      planI(1, a, members['bob.iitr.eth'] as AddressPh, BASE),
    ];
    expect(await validate(ctx, plan)).toEqual({ kind: 'continue' });
    const big = mintAmount(ctx, '101');
    const bad = [
      planI(0, big, members['alice.iitr.eth'] as AddressPh, BASE),
      planI(1, big, members['bob.iitr.eth'] as AddressPh, BASE),
    ];
    expectError(await validate(ctx, bad), 'LIMIT_PER_TX', { amount: '101' });
  });

  it('C-259 §11 V-14 k amount_per_payment over per_tx_max → LIMIT_PER_TX', async () => {
    const { ctx, r } = base({ balances: usdc('0', '5000', '0') });
    const k = planK(ctx, 0, r, BASE, { amount: '101', per_period: '10', total: '800' });
    expectError(await validate(ctx, [k]), 'LIMIT_PER_TX', { amount: '101', token: 'USDC', max: '100' });
  });

  it('C-259 §11 V-14 k per_period_cap over autopay_max_per_period → LIMIT_AUTOPAY_PERIOD', async () => {
    const { ctx, r } = base({ balances: usdc('0', '5000', '0') });
    const k = planK(ctx, 0, r, BASE, { amount: '10', per_period: '101', total: '800' });
    const msg = expectError(await validate(ctx, [k]), 'LIMIT_AUTOPAY_PERIOD', {
      cap: '101',
      token: 'USDC',
      max: '100',
    });
    expect(msg).toBe('This pays 101 USDC a week, over your autopay limit of 100 a week.');
  });

  it('C-259 §11 V-14 k lasting longer than autopay_max_weeks → LIMIT_AUTOPAY_DURATION', async () => {
    const { ctx, r } = base({ balances: usdc('0', '5000', '0') });
    const long: Schedule = weekly(['FRI'], '2026-11-06T10:00:00.000+05:30', { type: 'on_date', date: '2028-01-01' });
    const k = planK(ctx, 0, r, BASE, { schedule: long, total: '100' });
    const msg = expectError(await validate(ctx, [k]), 'LIMIT_AUTOPAY_DURATION', { weeks: '52' });
    expect(msg).toBe('Repeating payments can run for at most 52 weeks.');
  });

  it('C-259 §11 V-14 a k within every limit passes', async () => {
    const { ctx, r } = base();
    expect(await validate(ctx, [planK(ctx, 0, r, BASE)])).toEqual({ kind: 'continue' });
  });

  it('C-259 §11 V-14 k funding uses total_cap as the need (V-10)', async () => {
    const { ctx, r } = base({ balances: usdc('0', '70', '0') });
    expectError(await validate(ctx, [planK(ctx, 0, r, BASE, { total: '80' })]), 'INSUFFICIENT_FUNDS', {
      need: '80',
    });
  });
});

describe('§11.3 V-15 daily limit', () => {
  // now = Thu 2026-11-05 17:30Z = 23:00 Asia/Kolkata; the local day is 2026-11-04T18:30Z … 2026-11-05T18:30Z.
  const T = (iso: string): string => iso;

  function seedRows(ctx: TestContext): void {
    ctx.repos.db6.insertMany([
      // counted: pending, created after local midnight but on the previous UTC date
      db6Row({ kind: 'payment', amount: '100', status: 'pending', created_at: T('2026-11-04T19:00:00.000Z') }),
      // counted: pending exactly at local midnight
      db6Row({ kind: 'payment', amount: '20', status: 'pending', created_at: T('2026-11-04T18:30:00.000Z') }),
      // counted: executed today (executed_at), created yesterday
      db6Row({
        kind: 'payment',
        amount: '50',
        status: 'executed',
        created_at: T('2026-11-03T10:00:00.000Z'),
        executed_at: T('2026-11-04T20:00:00.000Z'),
      }),
      // counted: bridge_buffer counts too
      db6Row({ kind: 'bridge_buffer', amount: '0.4', status: 'pending', created_at: T('2026-11-05T10:00:00.000Z') }),
      // NOT counted: pending one second before local midnight (yesterday local, today UTC? no: UTC Nov 4)
      db6Row({ kind: 'payment', amount: '1000', status: 'pending', created_at: T('2026-11-04T18:29:59.000Z') }),
      // NOT counted: executed yesterday local
      db6Row({
        kind: 'payment',
        amount: '1000',
        status: 'executed',
        created_at: T('2026-11-04T10:00:00.000Z'),
        executed_at: T('2026-11-04T18:29:59.000Z'),
      }),
      // NOT counted: failed today
      db6Row({ kind: 'payment', amount: '1000', status: 'failed', created_at: T('2026-11-05T10:00:00.000Z') }),
      // NOT counted: counts_toward_limit = 0 (bridge_out / autopay_prefund)
      db6Row({ kind: 'bridge_out', amount: '1000', status: 'pending', created_at: T('2026-11-05T10:00:00.000Z') }),
      db6Row({
        kind: 'autopay_prefund',
        amount: '1000',
        status: 'executed',
        created_at: T('2026-11-05T10:00:00.000Z'),
        executed_at: T('2026-11-05T10:00:00.000Z'),
      }),
      // other token is not counted for a USDC request
      db6Row({
        kind: 'payment',
        amount: '1000',
        token: 'ETH',
        status: 'pending',
        created_at: T('2026-11-05T10:00:00.000Z'),
      }),
    ]);
  }

  function twoI(ctx: TestContext, r: AddressPh, each: string): InternalIntent[] {
    const a = mintAmount(ctx, each);
    return [planI(0, a, r, BASE), planI(1, a, r, BASE)];
  }

  it('C-260 C-385 §11 V-15 counts pending/executed/counting rows of today in the session timezone only; remaining = 300 − 170.4', async () => {
    const { ctx, r } = base({ balances: usdc('0', '5000', '0') });
    seedRows(ctx);
    // spent_today = 100 + 20 + 50 + 0.4 = 170.4, this request 2 × 65 = 130 → 300.4 > 300
    const res = await validate(ctx, twoI(ctx, r, '65'));
    const msg = expectError(res, 'LIMIT_DAILY', { token: 'USDC', remaining: '129.6' });
    expect(msg).toBe("This would go over today's USDC limit. You can still send 129.6 today.");
  });

  it('C-260 §11 V-15 spent_today + this_request == daily_max passes (boundary)', async () => {
    const { ctx, r } = base({ balances: usdc('0', '5000', '0') });
    seedRows(ctx);
    // 170.4 + 129.6 = 300
    expect(await validate(ctx, twoI(ctx, r, '64.8'))).toEqual({ kind: 'continue' });
  });

  it('C-260 §11 V-15 yesterday-local rows (even if the UTC date is today) never count; with only them anything up to 300 passes', async () => {
    const { ctx, r } = base({ balances: usdc('0', '5000', '0') });
    ctx.repos.db6.insertMany([
      db6Row({ kind: 'payment', amount: '999', status: 'pending', created_at: T('2026-11-04T18:29:59.000Z') }),
      db6Row({
        kind: 'payment',
        amount: '999',
        status: 'executed',
        created_at: T('2026-11-03T10:00:00.000Z'),
        executed_at: T('2026-11-04T18:29:59.000Z'),
      }),
    ]);
    expect(await validate(ctx, twoI(ctx, r, '100'))).toEqual({ kind: 'continue' });
    const third = [...twoI(ctx, r, '100'), planI(2, mintAmount(ctx, '100'), r, BASE)];
    expect(await validate(ctx, third)).toEqual({ kind: 'continue' });
    const over = [...third, planI(3, mintAmount(ctx, '0.01'), r, BASE)];
    expectError(await validate(ctx, over), 'LIMIT_DAILY', { remaining: '300' });
  });

  it('C-260 §11 V-15 a failed row never counts (alone it leaves the full 300 allowance)', async () => {
    const { ctx, r } = base({ balances: usdc('0', '5000', '0') });
    ctx.repos.db6.insertMany([
      db6Row({ kind: 'payment', amount: '299', status: 'failed', created_at: T('2026-11-05T10:00:00.000Z') }),
    ]);
    expect(await validate(ctx, twoI(ctx, r, '100'))).toEqual({ kind: 'continue' });
  });

  it('C-260 §11 V-15 spent_today above the max → remaining reported as 0', async () => {
    const { ctx, r } = base();
    ctx.repos.db6.insertMany([
      db6Row({
        kind: 'payment',
        amount: '301',
        status: 'executed',
        created_at: '2026-11-05T10:00:00.000Z',
        executed_at: '2026-11-05T10:00:00.000Z',
      }),
    ]);
    expectError(await validate(ctx, [iOf(ctx, '1', r)]), 'LIMIT_DAILY', { remaining: '0' });
  });

  it('C-260 §11 V-15 the same rows in UTC (timezone shifts the day boundary): 18:30Z rows of Nov 4 no longer count', async () => {
    const { ctx, r } = base({ balances: usdc('0', '5000', '0'), timezone: 'UTC' });
    ctx.repos.db6.insertMany([
      db6Row({ kind: 'payment', amount: '250', status: 'pending', created_at: T('2026-11-04T19:00:00.000Z') }),
      db6Row({ kind: 'payment', amount: '10', status: 'pending', created_at: T('2026-11-05T00:00:00.000Z') }),
    ]);
    // UTC day starts at 2026-11-05T00:00Z: only the 10 counts → remaining 290
    expectError(
      await validate(ctx, [
        iOf(ctx, '100', r),
        planI(1, mintAmount(ctx, '100'), r, BASE),
        planI(2, mintAmount(ctx, '100'), r, BASE),
      ]),
      'LIMIT_DAILY',
      { remaining: '290' },
    );
  });

  it('C-216 §10.4 V-15 a j buffer (padded − deliverable) counts toward the daily limit; the deliverable does not', async () => {
    const { ctx, r } = base({ balances: usdc('0', '30', '60') });
    ctx.repos.db6.insertMany([
      db6Row({ kind: 'payment', amount: '249.7', status: 'pending', created_at: T('2026-11-05T10:00:00.000Z') }),
    ]);
    // request: i 50 + buffer 0.4 = 50.4 → 300.1 > 300
    const j = planJ(ctx, 0, ARB, BASE, '20.4', '20', [1]);
    const i = planI(1, mintAmount(ctx, '50'), r, BASE, { depends_on: [0] });
    expectError(await validate(ctx, [j, i]), 'LIMIT_DAILY', { remaining: '50.3' });
    // without the buffer (50 alone) the same spend would fit: 249.7 + 50 = 299.7
    const c2 = base({ balances: usdc('0', '100', '0') });
    c2.ctx.repos.db6.insertMany([
      db6Row({ kind: 'payment', amount: '249.7', status: 'pending', created_at: T('2026-11-05T10:00:00.000Z') }),
    ]);
    expect(await validate(c2.ctx, [iOf(c2.ctx, '50', c2.r)])).toEqual({ kind: 'continue' });
  });

  it('C-260 §11 V-15 k creation adds 0 to the request total', async () => {
    const { ctx, r } = base({ balances: usdc('0', '5000', '0') });
    ctx.repos.db6.insertMany([
      db6Row({ kind: 'payment', amount: '299', status: 'pending', created_at: T('2026-11-05T10:00:00.000Z') }),
    ]);
    expect(await validate(ctx, [planK(ctx, 0, r, BASE, { total: '80' })])).toEqual({ kind: 'continue' });
  });

  it('C-260 §11 V-15 limits are per token (USDC spent does not block an ETH payment)', async () => {
    const { ctx, r } = base();
    ctx.repos.db6.insertMany([
      db6Row({ kind: 'payment', amount: '300', status: 'pending', created_at: T('2026-11-05T10:00:00.000Z') }),
    ]);
    const eth = planI(0, mintAmount(ctx, '0.01', 'ETH'), r, BASE, { token: 'ETH' });
    expect(await validate(ctx, [eth])).toEqual({ kind: 'continue' });
  });
});

describe('§13.4 Q_GROUP_OVER_LIMIT (C-326)', () => {
  function groupSetup(): { ctx: TestContext; plan: InternalIntent[] } {
    const ctx = ctxD({ balances: usdc('0', '500', '0') });
    const { group, members } = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [
        { subname: 'alice.iitr.eth', address: ALICE_CS },
        { subname: 'bob.iitr.eth', address: BOB_CS },
      ],
    });
    const a = addAmount(ctx, '10');
    ctx.req.payments = [pay(ctx, 'i', a, group, BASE)];
    ctx.repos.db6.insertMany([
      db6Row({ kind: 'payment', amount: '290', status: 'pending', created_at: '2026-11-05T10:00:00.000Z' }),
    ]);
    const plan = [
      planI(0, a, members['alice.iitr.eth'] as AddressPh, BASE),
      planI(1, a, members['bob.iitr.eth'] as AddressPh, BASE),
    ];
    return { ctx, plan };
  }

  it('C-326 E4 §11 V-15: a group request over the daily limit asks Q_GROUP_OVER_LIMIT with Yes, this once / No', async () => {
    const { ctx, plan } = groupSetup();
    const q = expectQuestion(await validate(ctx, plan), 'Q_LIMIT_OVERRIDE');
    expect(q.text).toBe("This sends 20 USDC, but only 10 is left of today's 300 limit. Go ahead this once?");
    expect(q.chips.map((c) => [c.id, c.label])).toEqual([
      ['override', 'Yes, this once'],
      ['no', 'No'],
    ]);
    expect(ctx.req.limit_override).toBe(false);
  });

  it('C-326 C-298 §13.4 "Yes, this once" (chip) sets the override, re-entering S10 continues; summary note appears once', async () => {
    const { ctx, plan } = groupSetup();
    const res = await validate(ctx, plan);
    const q = expectQuestion(res, 'Q_LIMIT_OVERRIDE');
    const answered = await s10.onAnswer?.(ctx, q, chip('override'));
    expect(answered).toEqual({ kind: 'continue' });
    expect(ctx.req.limit_override).toBe(true);
    expect(await s10.step(ctx)).toEqual({ kind: 'continue' });
    expect(await s10.step(ctx)).toEqual({ kind: 'continue' }); // re-entrant: note not duplicated
    expect(ctx.req.notes.filter((n) => n === NOTES.LIMIT_LIFTED())).toHaveLength(1);
    expect(NOTES.LIMIT_LIFTED()).toBe("Today's limit was lifted once for this group payment.");
    const summary = buildSummary(ctx, plan);
    expect(summary.notes).toContain("Today's limit was lifted once for this group payment.");
    // DB5 is unchanged by the override
    expect(ctx.repos.db5.getAll().daily_max.USDC).toBe('300');
  });

  it('C-326 §13.4 a plain "yes" typed answer is accepted as Yes', async () => {
    const { ctx, plan } = groupSetup();
    const q = expectQuestion(await validate(ctx, plan), 'Q_LIMIT_OVERRIDE');
    expect(await s10.onAnswer?.(ctx, q, text(' Yes '))).toEqual({ kind: 'continue' });
    expect(ctx.req.limit_override).toBe(true);
  });

  it('C-326 §13.4 the label text "Yes, this once" is accepted', async () => {
    const { ctx, plan } = groupSetup();
    const q = expectQuestion(await validate(ctx, plan), 'Q_LIMIT_OVERRIDE');
    expect(await s10.onAnswer?.(ctx, q, text('yes, this once'))).toEqual({ kind: 'continue' });
    expect(ctx.req.limit_override).toBe(true);
  });

  it('C-326 SQ-15 §13.4 "No" → DISCARDED with the "Cancelled. Nothing was sent." reply, override stays off', async () => {
    const { ctx, plan } = groupSetup();
    const q = expectQuestion(await validate(ctx, plan), 'Q_LIMIT_OVERRIDE');
    for (const a of [chip('no'), text('no')]) {
      const r = await s10.onAnswer?.(ctx, q, a);
      expect(r).toEqual({ kind: 'discard', messages: [REPLY.CANCELLED()] });
    }
    expect(ctx.req.limit_override).toBe(false);
    expect(REPLY.CANCELLED()).toBe('Cancelled. Nothing was sent.');
  });

  it('C-326 §9.7 an invalid answer re-asks the same question with attempt + 1', async () => {
    const { ctx, plan } = groupSetup();
    const q = expectQuestion(await validate(ctx, plan), 'Q_LIMIT_OVERRIDE');
    const r = await s10.onAnswer?.(ctx, q, text('maybe'));
    expect(r?.kind).toBe('question');
    if (r?.kind === 'question') {
      expect(r.question.code).toBe('Q_LIMIT_OVERRIDE');
      expect(r.question.attempt).toBe(q.attempt + 1);
    }
    expect(ctx.req.limit_override).toBe(false);
  });

  it('C-326 §11 V-15 without a group payment the same overage is LIMIT_DAILY, not a question', async () => {
    const { ctx, r } = base({ balances: usdc('0', '5000', '0') });
    ctx.repos.db6.insertMany([
      db6Row({ kind: 'payment', amount: '290', status: 'pending', created_at: '2026-11-05T10:00:00.000Z' }),
    ]);
    ctx.req.payments = [];
    const a = mintAmount(ctx, '20');
    expectError(await validate(ctx, [planI(0, a, r, BASE)]), 'LIMIT_DAILY', { remaining: '10' });
  });

  it('C-326 §11 V-15 the override applies to the whole request but only to the daily limit (per-tx still enforced)', async () => {
    const { ctx, r } = base({ balances: usdc('0', '5000', '0') });
    ctx.req.limit_override = true;
    ctx.repos.db6.insertMany([
      db6Row({ kind: 'payment', amount: '290', status: 'pending', created_at: '2026-11-05T10:00:00.000Z' }),
    ]);
    expectError(await validate(ctx, [iOf(ctx, '101', r)]), 'LIMIT_PER_TX');
  });

  it('C-326 an unknown question code answered to S10 → INTERNAL_ERROR', async () => {
    const { ctx, plan } = groupSetup();
    const q = expectQuestion(await validate(ctx, plan), 'Q_LIMIT_OVERRIDE');
    const res = await s10.onAnswer?.(ctx, { ...q, code: 'Q_GROUP_CHAIN' }, chip(CHIPS.YES.id));
    expect(res).toEqual({ kind: 'error', code: 'INTERNAL_ERROR' });
  });
});
