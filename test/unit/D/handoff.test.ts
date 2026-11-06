// Lane D tester: S12 hand-off — §8.14 swap_back, §12.5 envelope, §14.2 execution client, §11.4 DB6 rows, DB7/DB8 effects,
// §16.2 allowlist (no names / ENS names / summary text to the execution layer), §15 errors.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { ERROR_MESSAGE, REPLY } from '../../../src/contracts/catalog.js';
import type { Address, AddressPh, HandoffEnvelope, InternalIntent, Payment } from '../../../src/contracts/types.js';
import { createExecutionClient, rejectMessage } from '../../../src/handoff/execution-client.js';
import { swapBack } from '../../../src/handoff/swap-back.js';
import { s12 } from '../../../src/pipeline/s12-handoff.js';
import { validators } from '../../../src/schemas/index.js';
import type { TestContext } from '../../fakes/context.js';
import { TEST_WALLET, testConfig } from '../../fakes/context.js';
import {
  ALICE_CS,
  ARADHYA_CS,
  ARB,
  BASE,
  BOB_CS,
  MIHIR_CS,
  SEPOLIA,
  USDC_ADDR,
  WALLET_CS,
  addAmount,
  addAradhya,
  addAutopay,
  addGroup,
  addMihir,
  addRecipient,
  ctxD,
  expectError,
  expectRuleLogged,
  mintAmount,
  pay,
  planI,
  planJ,
  planK,
  planL,
  planIdFor,
  sched,
  weekly,
} from './helpers.js';
import { usdc } from './s9-helpers.js';

const NOW_ISO = '2026-11-05T17:30:00Z';

function envelopeOf(ctx: TestContext): HandoffEnvelope {
  const sub = ctx.exec.submissions[0];
  expect(sub).toBeDefined();
  return (sub as NonNullable<typeof sub>).envelope;
}

async function handoff(ctx: TestContext, plan: InternalIntent[], payments?: Payment[]) {
  ctx.req.plan = plan;
  if (payments) ctx.req.payments = payments;
  ctx.req.state = 'AWAITING_CONFIRMATION';
  return s12.step(ctx);
}

describe('C-451 §20.1 handoff: §8.14 step 1 / §12.5 swap_back envelope', () => {
  it('C-150 C-275 C-276 C-277 E1: i intent → exact spec envelope (token_address, base_units, checksummed recipient)', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '60') });
    const a = addAradhya(ctx);
    const res = await handoff(ctx, [planI(0, mintAmount(ctx, '50'), a, BASE)]);
    expect(res).toEqual({ kind: 'answer', messages: ['Sent to your wallet for signing.'] });
    expect(envelopeOf(ctx)).toEqual({
      version: '2',
      request_id: ctx.req.request_id,
      wallet_address: WALLET_CS,
      created_at: NOW_ISO,
      intents: [
        {
intent_id: 'i',
step: 0,
depends_on: [],
token: 'USDC',
token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
chain_id: 84532,
recipients: [{ amount: { value: '50', base_units: '50000000', decimals: 6 }, recipient: ARADHYA_CS }]
},
      ],
    });
  });

  it("C-275 §12.5 token_address: ETH → null; USDC → the chain's usdc_address from config", async () => {
    const ctx = ctxD({ balances: usdc('100', '100', '100') });
    const a = addAradhya(ctx);
    const plan = [
      planI(0, mintAmount(ctx, '1'), a, SEPOLIA),
      planI(1, mintAmount(ctx, '1'), a, BASE),
      planI(2, mintAmount(ctx, '1'), a, ARB),
      planI(3, mintAmount(ctx, '0.01', 'ETH'), a, BASE, { token: 'ETH' }),
    ];
    const env = swapBack(ctx, plan);
    const is = env.intents.map((x) => (x.intent_id === 'i' ? x.token_address : 'n/a'));
    expect(is).toEqual([USDC_ADDR[SEPOLIA], USDC_ADDR[BASE], USDC_ADDR[ARB], null]);
    expect(env.intents[3]).toMatchObject({ recipients: [{ amount: { value: '0.01', base_units: '10000000000000000', decimals: 18 } }] });
  });

  it('C-275 E2 §12.5 j intent: both token addresses set (per chain), amount = padded, receiver self, funds_steps, no deliverable', async () => {
    const ctx = ctxD({ balances: usdc('0', '30', '60') });
    const j = planJ(ctx, 0, ARB, BASE, '20.4', '20', [1]);
    const i = planI(1, mintAmount(ctx, '50'), addAradhya(ctx), BASE, { depends_on: [0] });
    const env = swapBack(ctx, [j, i]);
    expect(env.intents[0]).toEqual({
      intent_id: 'j',
      step: 0,
      token: 'USDC',
      source_token_address: USDC_ADDR[ARB],
      dest_token_address: USDC_ADDR[BASE],
      source_chain_id: ARB,
      dest_chain_id: BASE,
      amount: { value: '20.4', base_units: '20400000', decimals: 6 },
      receiver: 'self',
      fee_max_eth: '0.002',
      funds_steps: [1],
    });
    expect(env.intents[1]).toMatchObject({ intent_id: 'i', depends_on: [0] });
  });

  it('the shared wire schema rejects an ETH bridge', () => {
    const ctx = ctxD();
    const j = planJ(ctx, 0, ARB, BASE, '1', '1', [1]);
    const i = planI(1, mintAmount(ctx, '1'), addAradhya(ctx), BASE, { depends_on: [0] });
    const env = swapBack(ctx, [j, i]);
    expect(validators.handoffEnvelope(env)).toBe(true);
    expect(validators.handoffEnvelope({ ...env, intents: [{ ...env.intents[0], token: 'ETH', source_token_address: null, dest_token_address: null }, env.intents[1]] })).toBe(false);
  });

  it('C-278 v2 k intent carries fixed UTC timing, recipients, per-run fees and delegation caps', () => {
    const { ctx, plan } = kPlan();
    const k = swapBack(ctx, plan).intents[0];
    const start = Date.parse('2026-11-06T04:30:00Z') / 1000;
    expect(k).toEqual({
      intent_id: 'k', step: 0, depends_on: [], autopay_id: 'ap_00000000000e',
      token: 'USDC', token_address: USDC_ADDR[BASE], chain_id: BASE,
      recipients: [{ recipient: MIHIR_CS, amount: { value: '10', base_units: '10000000', decimals: 6 } }],
      fee: { to: getAddress(ctx.config.autopay!.fee_collector), amount: { value: '0.05', base_units: '50000', decimals: 6 } },
      schedule: { start_at: start, interval_seconds: 604800, max_runs: 8, late_window_seconds: 3600, end_at: start + 7 * 604800 + 3600 },
      limits: { max_per_run: { value: '10.05', base_units: '10050000', decimals: 6 }, max_total: { value: '80.4', base_units: '80400000', decimals: 6 } },
      executor: 'chainlink-cre',
    });
    expect(k).not.toHaveProperty('display');
    expect(k).not.toHaveProperty('prefund');
  });

  it('C-150 E7 §12.5 l intent: autopay_id, chain and on-chain plan_id only', () => {
    const ctx = ctxD({ actions: ['l'] });
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7' });
    const env = swapBack(ctx, [planL(0, addMihir(ctx), 'ap_0000000000f7')]);
    expect(env.intents).toEqual([
      {
        intent_id: 'l',
        step: 0,
        autopay_id: 'ap_0000000000f7',
        chain_id: BASE,
        plan_id: planIdFor('ap_0000000000f7'),
      },
    ]);
  });

  it('C-277 §12.5 lower-case DB3 / wallet addresses are checksummed before validation', () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    const lower = addRecipient(ctx, { name: 'Low', address: ARADHYA_CS.toLowerCase() as Address, dbOnly: true });
    const env = swapBack(ctx, [planI(0, mintAmount(ctx, '5'), lower, BASE)]);
    expect(env.wallet_address).toBe(getAddress(TEST_WALLET));
    expect(env.wallet_address).not.toBe(TEST_WALLET.toLowerCase());
    expect(env.intents[0]).toMatchObject({ recipients: [{ recipient: ARADHYA_CS }] });
    expect(validators.handoffEnvelope(env)).toBe(true);
  });

  it('C-276 §12.5 value without trailing zeros; base_units via bigint beyond 2^53 (USDC and ETH)', () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    const a = addAradhya(ctx);
    const env = swapBack(ctx, [
      planI(0, mintAmount(ctx, '50.500'), a, BASE),
      planI(1, mintAmount(ctx, '9007199254740993.000001'), a, BASE),
      planI(2, mintAmount(ctx, '123456789.123456789012345678', 'ETH'), a, BASE, { token: 'ETH' }),
    ]);
    const amounts = env.intents.map((x) => (x.intent_id === 'i' ? x.recipients[0]!.amount : null));
    expect(amounts).toEqual([
      { value: '50.5', base_units: '50500000', decimals: 6 },
      { value: '9007199254740993.000001', base_units: '9007199254740993000001', decimals: 6 },
      { value: '123456789.123456789012345678', base_units: '123456789123456789012345678', decimals: 18 },
    ]);
  });

  it('C-402 §16.2 allowlist: each envelope and intent has exactly the §12.5 keys, nothing else', () => {
    const ctx = ctxD({ balances: usdc('0', '300', '300') });
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7' });
    const mi = addMihir(ctx);
    const j = planJ(ctx, 0, ARB, BASE, '20.4', '20', [1]);
    const i = planI(1, mintAmount(ctx, '50'), addAradhya(ctx), BASE, { depends_on: [0] });
    const k = planK(ctx, 2, mi, BASE);
    const l = planL(3, mi, 'ap_0000000000f7');
    const env = swapBack(ctx, [j, i, k, l]);
    expect(Object.keys(env).sort()).toEqual(['created_at', 'intents', 'request_id', 'version', 'wallet_address']);
    const keys = env.intents.map((x) => Object.keys(x).sort());
    expect(keys[0]).toEqual(
      [
        'amount',
        'dest_chain_id',
        'dest_token_address',
        'funds_steps',
        'fee_max_eth',
        'intent_id',
        'receiver',
        'source_chain_id',
        'source_token_address',
        'step',
        'token',
      ].sort(),
    );
    expect(keys[1]).toEqual(
      ['recipients', 'chain_id', 'depends_on', 'intent_id', 'step', 'token', 'token_address'].sort(),
    );
    expect(keys[2]).toEqual(
      [
        'autopay_id',
        'chain_id',
        'executor',
        'depends_on',
        'intent_id',
        'limits',
        'fee',
        'recipients',
        'schedule',
        'step',
        'token',
        'token_address',
      ].sort(),
    );
    expect(keys[3]).toEqual(
      ['autopay_id', 'chain_id', 'plan_id', 'intent_id', 'step'].sort(),
    );
    expect(validators.handoffEnvelope(env)).toBe(true);
  });

  it('C-403 §16.2 no name, ENS name, summary text, note, prompt text or placeholder reaches the execution layer', async () => {
    const ctx = ctxD({ balances: usdc('0', '300', '300') });
    ctx.req.typed_text = 'send 5 usdc to Aradhya and everyone on iitr.eth';
    ctx.req.notes.push('Skipped carol.iitr.eth: no address on Base Sepolia.');
    ctx.req.summary = { text: 'Please confirm:\n1. Send ...', lines: ['1. Send'], notes: ['n'], footer: ['f'] };
    const ens = addRecipient(ctx, { name: 'riya', ens_name: 'riya.eth', address: ALICE_CS, source: 'ens' });
    const { members } = addGroup(ctx, {
      parent: 'iitr.eth',
      chain_id: BASE,
      members: [
        { subname: 'alice.iitr.eth', address: ALICE_CS },
        { subname: 'bob.iitr.eth', address: BOB_CS },
      ],
    });
    const a = addAradhya(ctx);
    const amt = mintAmount(ctx, '5');
    const plan = [
      planI(0, amt, a, BASE),
      planI(1, amt, ens, BASE),
      planI(2, amt, members['alice.iitr.eth'] as AddressPh, BASE),
      planI(3, amt, members['bob.iitr.eth'] as AddressPh, BASE),
    ];
    const res = await handoff(ctx, plan);
    expect(res.kind).toBe('answer');
    const body = JSON.stringify(envelopeOf(ctx));
    for (const forbidden of [
      'Aradhya',
      'aradhya',
      'riya',
      'iitr',
      'alice',
      'bob',
      'carol',
      'Skipped',
      'Please confirm',
      'Confirm?',
      'send 5 usdc',
      'amount_',
      'address_',
      'group_',
      'Spent today',
    ]) {
      expect(body).not.toContain(forbidden);
    }
    expect(JSON.stringify(ctx.req.envelope)).toBe(body);
  });
});

function kPlan(): { ctx: TestContext; plan: InternalIntent[] } {
  const ctx = ctxD({ actions: ['k'], balances: usdc('0', '1000', '0') });
  const mi = addMihir(ctx);
  return { ctx, plan: [planK(ctx, 0, mi, BASE, { amount: '10' })] };
}

describe('§8.14 step 2 HANDOFF_INVALID (SQ-02)', () => {
  function expectInvalid(ctx: TestContext, res: Awaited<ReturnType<typeof handoff>>): void {
    expect(expectError(res, 'INTERNAL_ERROR')).toBe('Something went wrong preparing this. Nothing was sent.');
    expectRuleLogged(ctx, 'HANDOFF_INVALID');
    expect(ctx.exec.submissions).toEqual([]);
    expect(ctx.req.state).not.toBe('HANDED_OFF');
    expect(ctx.repos.tables.db6).toEqual([]);
    expect(ctx.repos.tables.db7.size).toBe(0);
    expect(ctx.repos.tables.db8_history).toEqual([]);
    expect(ctx.req.envelope).toBeUndefined();
  }

  it('C-151 SQ-02 §12.5 a DB3 address that is not an address → HANDOFF_INVALID, INTERNAL_ERROR to the user, nothing submitted', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    const bad = addRecipient(ctx, { name: 'Bad', address: '0xnothex' as Address, dbOnly: true });
    expectInvalid(ctx, await handoff(ctx, [planI(0, mintAmount(ctx, '5'), bad, BASE)]));
  });

  it('C-151 SQ-02 §12.5 a missing DB1 row → HANDOFF_INVALID', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    const a = addAradhya(ctx);
    const it = planI(0, 'amount_00000000' as never, a, BASE);
    expectInvalid(ctx, await handoff(ctx, [it]));
  });

  it('C-151 SQ-02 §12.5 an envelope failing the schema (zero amount: base_units must be >0) → HANDOFF_INVALID', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    const a = addAradhya(ctx);
    expectInvalid(ctx, await handoff(ctx, [planI(0, mintAmount(ctx, '0'), a, BASE)]));
  });

  it('C-151 SQ-02 §12.5 an envelope failing the schema (malformed autopay_id) → HANDOFF_INVALID', async () => {
    const { ctx, plan } = kPlan();
    const k = plan[0];
    if (k?.intent_id !== 'k') throw new Error('k expected');
    expectInvalid(ctx, await handoff(ctx, [{ ...k, autopay_id: 'not-an-autopay' as never }]));
  });

  it('C-151 SQ-02 §12.5 a chain missing from config → HANDOFF_INVALID', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    const a = addAradhya(ctx);
    expectInvalid(ctx, await handoff(ctx, [planI(0, mintAmount(ctx, '5'), a, 1 as never)]));
  });

  it('C-151 C-393 SQ-02 no plan on the request → HANDOFF_INVALID', async () => {
    const ctx = ctxD();
    delete ctx.req.plan;
    expectInvalid(ctx, await s12.step(ctx));
  });

  it('C-393 §15 INTERNAL_ERROR message and the log line carry rule_id HANDOFF_INVALID (letters-first, no dots, ≤ 64)', async () => {
    const ctx = ctxD();
    const bad = addRecipient(ctx, { name: 'Bad', address: '0xnothex' as Address, dbOnly: true });
    await handoff(ctx, [planI(0, mintAmount(ctx, '5'), bad, BASE)]);
    const line = ctx.log.lines.find((l) => l.rule_id === 'HANDOFF_INVALID');
    expect(line).toMatchObject({ level: 'error', step: 's12', error_code: 'INTERNAL_ERROR' });
    expect(String(line?.event)).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
    expect(JSON.stringify(ctx.log.lines)).not.toContain('0xnothex');
  });
});

describe('§8.14 steps 3–4 accepted hand-off: DB6 / DB7 / DB8 (§11.4, SQ-C-08)', () => {
  it('C-152 C-153 C-262 §11.4 i → one payment row counting toward the limit; Idempotency-Key = request_id', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '60') });
    const res = await handoff(ctx, [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)]);
    expect(res).toEqual({ kind: 'answer', messages: [REPLY.HANDED_OFF()] });
    expect(ctx.exec.submissions).toHaveLength(1);
    expect(ctx.exec.submissions[0]?.idempotencyKey).toBe(ctx.req.request_id);
    expect(ctx.repos.tables.db6).toEqual([
      {
id: expect.any(Number),
request_id: ctx.req.request_id,
step: 0,
kind: 'payment',
counts_toward_limit: true,
chain_id: BASE,
token: 'USDC',
recipient_address: ARADHYA_CS,
intent_id: 'i',
autopay_id: null,
status: 'pending',
tx_hash: null,
created_at: NOW_ISO,
executed_at: null,
amount: '50'
},
    ]);
    expect(ctx.req.state).toBe('HANDED_OFF');
    expect(ctx.log.lines.some((l) => l.event === 'handed_off' && l.level === 'info')).toBe(true);
  });

  it('C-263 E2 §11.4 j → bridge_out (padded, counts 0) + bridge_buffer (padded − deliverable, counts 1), both on the source chain', async () => {
    const ctx = ctxD({ balances: usdc('0', '30', '60') });
    const j = planJ(ctx, 0, ARB, BASE, '20.4', '20', [1]);
    const i = planI(1, mintAmount(ctx, '50'), addAradhya(ctx), BASE, { depends_on: [0] });
    await handoff(ctx, [j, i]);
    const rows = ctx.repos.tables.db6.map((r) => ({
      step: r.step,
      kind: r.kind,
      counts: r.counts_toward_limit,
      chain: r.chain_id,
      amount: r.amount,
      to: r.recipient_address,
      intent: r.intent_id,
      status: r.status,
    }));
    expect(rows).toEqual([
      {
        step: 0,
        kind: 'bridge_out',
        counts: false,
        chain: ARB,
        amount: '20.4',
        to: null,
        intent: 'j',
        status: 'pending',
      },
      {
        step: 0,
        kind: 'bridge_buffer',
        counts: true,
        chain: ARB,
        amount: '0.4',
        to: null,
        intent: 'j',
        status: 'pending',
      },
      { step: 0, kind: 'bridge_fee', counts: true, chain: ARB, amount: '0.002', to: null, intent: 'j', status: 'pending' },
      {
        step: 1,
        kind: 'payment',
        counts: true,
        chain: BASE,
        amount: '50',
        to: ARADHYA_CS,
        intent: 'i',
        status: 'pending',
      },
    ]);
  });

  it('C-263 E3 §11.4 the 10.2 / 10 bridge writes a 0.2 buffer (60.2 counted in total)', async () => {
    const ctx = ctxD({ balances: usdc('0', '30', '50') });
    const j = planJ(ctx, 0, ARB, BASE, '10.2', '10', [1]);
    const plan = [
      j,
      planI(1, mintAmount(ctx, '40'), addAradhya(ctx), BASE, { depends_on: [0] }),
      planI(2, mintAmount(ctx, '20'), addMihir(ctx), ARB),
    ];
    await handoff(ctx, plan);
    const counted = ctx.repos.tables.db6.filter((r) => r.counts_toward_limit).map((r) => r.amount);
    expect(counted).toEqual(['0.2', '0.002', '40', '20']);
  });

  it('C-264 v2 k records the exact schedule and recipients in DB7 without a prefund debit', async () => {
    const { ctx, plan } = kPlan();
    expect((await handoff(ctx, plan)).kind).toBe('answer');
    expect(ctx.repos.tables.db6).toEqual([]);
    const rows = ctx.repos.db7.listByRequest(ctx.req.request_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      autopay_id: 'ap_00000000000e', request_id: ctx.req.request_id, recipient_name: 'Mihir',
      recipient_address: MIHIR_CS, chain_id: BASE, token: 'USDC', amount_per_payment: '10', fee: '0.05',
      status: 'pending', plan_id: null, executor_address: null,
    });
    const k = envelopeOf(ctx).intents[0];
    if (k?.intent_id !== 'k') throw new Error('missing autopay');
    expect(JSON.parse(rows[0]!.schedule_json)).toEqual(k.schedule);
    expect(JSON.parse(rows[0]!.recipients_json!)).toEqual(k.recipients);
  });

  it('C-265 E7 §11.4 l → no DB6 row and no new DB7 row; the existing autopay row is untouched', async () => {
    const ctx = ctxD({ actions: ['l'] });
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7' });
    const before = JSON.stringify(ctx.repos.db7.get('ap_0000000000f7'));
    const res = await handoff(ctx, [planL(0, addMihir(ctx), 'ap_0000000000f7')]);
    expect(res.kind).toBe('answer');
    expect(ctx.repos.tables.db6).toEqual([]);
    expect(ctx.repos.tables.db7.size).toBe(1);
    expect(JSON.stringify(ctx.repos.db7.get('ap_0000000000f7'))).toBe(before);
    expect(ctx.req.state).toBe('HANDED_OFF');
    expect(ctx.repos.tables.db8_history).toHaveLength(1);
  });

  it('C-153 SQ-C-08 db8_history payments_json = the S8 payments (placeholders only) + numeric chain_id S9 assigned', async () => {
    const ctx = ctxD({ balances: usdc('0', '30', '60') });
    const r = addAradhya(ctx);
    const amt = addAmount(ctx, '50');
    const payment = pay(ctx, 'i', amt, r, 'unstated');
    const j = planJ(ctx, 0, ARB, BASE, '20.4', '20', [1]);
    await handoff(ctx, [j, planI(1, amt, r, BASE, { depends_on: [0] })], [payment]);
    const hist = ctx.repos.db8.recentHistory(ctx.req.session_id, 5);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      session_id: ctx.req.session_id,
      request_id: ctx.req.request_id,
      handed_off_at: NOW_ISO,
    });
    const items = JSON.parse(hist[0]?.payments_json ?? '[]') as Array<Record<string, unknown>>;
    expect(items).toEqual([{ ...payment, chain_id: 84532 }]);
    expect(typeof items[0]?.chain_id).toBe('number');
    expect(hist[0]?.payments_json).not.toContain(ARADHYA_CS);
    expect(hist[0]?.payments_json).not.toContain('Aradhya');
  });

  it('C-153 SQ-C-08 E3: two payments get each their own plan chain_id; model order kept', async () => {
    const ctx = ctxD({ balances: usdc('0', '30', '50') });
    const a = addAradhya(ctx);
    const mi = addMihir(ctx);
    const a1 = addAmount(ctx, '40');
    const a2 = addAmount(ctx, '20');
    const p1 = pay(ctx, 'i', a1, a, BASE);
    const p2 = pay(ctx, 'i', a2, mi, ARB);
    const plan = [
      planJ(ctx, 0, ARB, BASE, '10.2', '10', [1]),
      planI(1, a1, a, BASE, { depends_on: [0] }),
      planI(2, a2, mi, ARB),
    ];
    await handoff(ctx, plan, [p2, p1]);
    const items = JSON.parse(ctx.repos.tables.db8_history[0]?.payments_json ?? '[]') as Array<{ chain_id: number }>;
    expect(items.map((x) => x.chain_id)).toEqual([ARB, BASE]);
  });

  it('C-153 SQ-C-08 E4: a group payment keeps the group placeholder and the group chain_id (members share it)', async () => {
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
    const payment = pay(ctx, 'i', a, group, BASE);
    await handoff(
      ctx,
      [
        planI(0, a, members['alice.iitr.eth'] as AddressPh, BASE),
        planI(1, a, members['bob.iitr.eth'] as AddressPh, BASE),
      ],
      [payment],
    );
    const items = JSON.parse(ctx.repos.tables.db8_history[0]?.payments_json ?? '[]') as Array<Record<string, unknown>>;
    expect(items).toEqual([{ ...payment, chain_id: BASE }]);
    expect(ctx.repos.tables.db8_history[0]?.payments_json).not.toContain('alice');
    expect(ctx.repos.tables.db6.filter((r) => r.kind === 'payment').map((r) => r.recipient_address)).toEqual([
      ALICE_CS,
      BOB_CS,
    ]);
  });

  it('C-153 SQ-C-08 E5/E6/E7: k and l payments are recorded with the plan chain too', async () => {
    const ctx = ctxD({ actions: ['k', 'l'], balances: usdc('0', '1000', '0') });
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7', chain_id: ARB });
    const mi = addMihir(ctx);
    const a = addAmount(ctx, '10');
    const kp = pay(ctx, 'k', a, mi, 'unstated', { frequency: 'weekly', interval: 1, days_of_week: ['FRI'] });
    const lp = pay(ctx, 'l', null, mi, 'unstated');
    const k = planK(ctx, 0, mi, BASE, { amountPh: a });
    const l = planL(1, mi, 'ap_0000000000f7', ARB);
    await handoff(ctx, [k, l], [kp, lp]);
    const items = JSON.parse(ctx.repos.tables.db8_history[0]?.payments_json ?? '[]') as Array<{
      kind: string;
      chain_id: number;
    }>;
    expect(items.map((x) => [x.kind, x.chain_id])).toEqual([
      ['k', BASE],
      ['l', ARB],
    ]);
  });

  it('C-153 §8.14 DB6 / DB7 / DB8 rows are written exactly once per accepted hand-off', async () => {
    const { ctx, plan } = kPlan();
    await handoff(ctx, plan);
    expect(ctx.repos.tables.db6).toHaveLength(0);
    expect(ctx.repos.tables.db7.size).toBe(1);
    expect(ctx.repos.tables.db8_history).toHaveLength(1);
  });

  it("C-262 §11.1 pending DB6 rows lower the next request's spendable (10 minute window) and count toward today", async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    await handoff(ctx, [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)]);
    const row = ctx.repos.db6.pendingRecent(BASE, 'USDC', '2026-11-05T17:31:00.000Z');
    expect(row.map((r) => r.amount)).toEqual(['50']);
    expect(ctx.repos.db6.spentToday('USDC', 'Asia/Kolkata', '2026-11-05T17:31:00.000Z').map((r) => r.amount)).toEqual([
      '50',
    ]);
  });
});

describe('§8.14 steps 5–6 / §15 rejected and unavailable', () => {
  it('C-154 C-391 4xx → EXECUTION_REJECTED; durable failed rows release reservations and no history is added', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    ctx.exec.responses = [{ status: 'rejected', message: 'insufficient allowance' }];
    const res = await handoff(ctx, [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)]);
    const msg = expectError(res, 'EXECUTION_REJECTED', { message: 'insufficient allowance' });
    expect(msg).toBe("Your wallet couldn't accept this: insufficient allowance");
    expect(ctx.repos.tables.db6).toHaveLength(1);
    expect(ctx.repos.tables.db6[0]).toMatchObject({ status: 'failed', amount: '50', tx_hash: null });
    expect(ctx.repos.db6.pendingRecent(BASE, 'USDC', NOW_ISO)).toEqual([]);
    expect(ctx.repos.handoffs.get(ctx.req.request_id)).toMatchObject({ status: 'rejected', history: null });
    expect(ctx.repos.tables.db7.size).toBe(0);
    expect(ctx.repos.tables.db8_history).toEqual([]);
    expect(ctx.req.state).not.toBe('HANDED_OFF');
    expect(res.kind === 'error' && res.final_state).toBeFalsy();
  });

  it('SQ-A-06 F-9 S12 passes the cause of an unavailable result on as params.cause', async () => {
    for (const cause of ['timeout', 'server_error'] as const) {
      const ctx = ctxD({ balances: usdc('0', '80', '0') });
      ctx.exec.responses = [{ status: 'unavailable', cause }];
      const res = await handoff(ctx, [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)]);
      expectError(res, 'EXECUTION_UNAVAILABLE', { cause });
    }
  });

  it('SQ-O-09 S12 cuts a 300-character rejection message to 200 characters and removes control characters', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    ctx.exec.responses = [{ status: 'rejected', message: `a\u0007${'b'.repeat(298)}\u001b` }];
    const res = await handoff(ctx, [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)]);
    const msg = expectError(res, 'EXECUTION_REJECTED', { message: `a${'b'.repeat(199)}` });
    expect(msg).toBe(`Your wallet couldn't accept this: a${'b'.repeat(199)}`);
  });

  it('C-392 5xx / timeout → EXECUTION_UNAVAILABLE; reservations persist without accepted history', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    ctx.exec.responses = [{ status: 'unavailable', cause: 'server_error' }];
    const res = await handoff(ctx, [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)]);
    expect(expectError(res, 'EXECUTION_UNAVAILABLE')).toBe("I couldn't reach your wallet. Confirm again to retry.");
    expect(ctx.repos.tables.db6).toHaveLength(1);
    expect(ctx.repos.tables.db6[0]).toMatchObject({ status: 'pending', amount: '50', tx_hash: null });
    expect(ctx.repos.db6.pendingRecent(BASE, 'USDC', NOW_ISO)).toHaveLength(1);
    expect(ctx.repos.handoffs.get(ctx.req.request_id)?.status).toBe('submitted');
    expect(ctx.repos.tables.db8_history).toEqual([]);
    expect(ctx.log.lines.some((l) => l.event === 'handoff_unavailable' && l.level === 'warn')).toBe(true);
  });

  it('C-152 §8.14 step 6 / §14.2 a retry after EXECUTION_UNAVAILABLE re-sends the SAME envelope with the SAME Idempotency-Key', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    ctx.exec.responses = [
      { status: 'unavailable', cause: 'server_error' },
      { status: 'unavailable', cause: 'server_error' },
    ];
    const plan = [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)];
    ctx.req.plan = plan;
    await s12.step(ctx);
    // time moves on and the runner counts the attempt; the envelope (incl. created_at) must not change
    const prevNow = ctx.now;
    ctx.now = () => prevNow().plus({ minutes: 3 });
    ctx.req.handoff_attempts = 1;
    await s12.step(ctx);
    ctx.req.handoff_attempts = 2;
    const third = await s12.step(ctx);
    expect(third.kind).toBe('answer');
    expect(ctx.exec.submissions).toHaveLength(3);
    const keys = ctx.exec.submissions.map((s) => s.idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([ctx.req.request_id]));
    expect(ctx.exec.submissions[1]?.envelope).toEqual(ctx.exec.submissions[0]?.envelope);
    expect(ctx.exec.submissions[2]?.envelope).toEqual(ctx.exec.submissions[0]?.envelope);
    // exactly one set of rows after the eventual success
    expect(ctx.repos.tables.db6).toHaveLength(1);
    expect(ctx.repos.tables.db8_history).toHaveLength(1);
  });

  it('C-154 SQ-D-09 the message of a rejection travels verbatim into the catalog template', () => {
    expect(ERROR_MESSAGE.EXECUTION_REJECTED({ message: 'HTTP 422' })).toBe(
      "Your wallet couldn't accept this: HTTP 422",
    );
  });
});

describe('§14.2 execution client (no network: fetch stubbed)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const env = (): HandoffEnvelope => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    return swapBack(ctx, [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)]);
  };

  function stub(res: Response | Error): ReturnType<typeof vi.fn> {
    const f = vi.fn(async () => {
      if (res instanceof Error) throw res;
      return res;
    });
    vi.stubGlobal('fetch', f);
    return f;
  }

  it('C-349 §14.2 POST {url}/v1/intents with Bearer outbound token, Idempotency-Key, JSON content type and the envelope as body', async () => {
    const f = stub(new Response('{}', { status: 200 }));
    const client = createExecutionClient(testConfig(), 'tok-out-123');
    const e = env();
    expect(await client.submit(e, 'req_5d1c0a9b8e7f')).toEqual({ status: 'accepted' });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8788/v1/intents');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Bearer tok-out-123',
      'Idempotency-Key': 'req_5d1c0a9b8e7f',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual(e);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
  });

  it('C-349 §14.2 a trailing slash on execution.url does not double up', async () => {
    const f = stub(new Response('{}', { status: 202 }));
    const cfg = testConfig();
    cfg.execution.url = 'http://127.0.0.1:8788///';
    await createExecutionClient(cfg, 't').submit(env(), 'k');
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('http://127.0.0.1:8788/v1/intents');
  });

  it('C-349 §14.2 any 2xx is accepted (200, 201, 202, 204)', async () => {
    for (const status of [200, 201, 202, 204]) {
      stub(new Response(null, { status }));
      expect(await createExecutionClient(testConfig(), 't').submit(env(), 'k')).toEqual({ status: 'accepted' });
    }
  });

  it('C-349 C-391 §14.2 4xx → rejected with the JSON body message', async () => {
    for (const status of [400, 401, 403, 409, 422]) {
      stub(new Response(JSON.stringify({ message: 'bad nonce' }), { status }));
      expect(await createExecutionClient(testConfig(), 't').submit(env(), 'k')).toEqual({
        status: 'rejected',
        message: 'bad nonce',
      });
    }
  });

  it('C-349 SQ-D-09 §14.2 4xx without a usable message (non-JSON, no message, empty, non-string) → "HTTP <status>"', async () => {
    const bodies: Array<[string, number]> = [
      ['<html>nope</html>', 400],
      ['{}', 404],
      ['{"message":""}', 409],
      ['{"message":42}', 422],
      ['null', 403],
    ];
    for (const [body, status] of bodies) {
      stub(new Response(body, { status }));
      expect(await createExecutionClient(testConfig(), 't').submit(env(), 'k')).toEqual({
        status: 'rejected',
        message: `HTTP ${status}`,
      });
    }
  });

  it('SQ-O-09 rejectMessage strips control characters and cuts to 200 code points', () => {
    expect(rejectMessage('a\u0000b\u001fc\u007fd\u009fe\nf\tg')).toBe('abcdefg');
    expect(rejectMessage('x'.repeat(300))).toHaveLength(200);
    // 200 code points, not UTF-16 units: an astral character counts once
    expect([...rejectMessage('😀'.repeat(300))]).toHaveLength(200);
    expect(rejectMessage('short')).toBe('short');
  });

  it('SQ-O-09 §14.2 a 300-character 4xx message reaches the result as 200 characters, control characters removed', async () => {
    stub(new Response(JSON.stringify({ message: `\u0007${'m'.repeat(299)}\u001b[0m` }), { status: 422 }));
    expect(await createExecutionClient(testConfig(), 't').submit(env(), 'k')).toEqual({
      status: 'rejected',
      message: 'm'.repeat(200),
    });
  });

  it('SQ-O-09 §14.2 a message that is only control characters or whitespace falls back to "HTTP <status>"', async () => {
    stub(new Response(JSON.stringify({ message: '\u0007\u0000 \n' }), { status: 409 }));
    expect(await createExecutionClient(testConfig(), 't').submit(env(), 'k')).toEqual({
      status: 'rejected',
      message: 'HTTP 409',
    });
  });

  it('C-349 C-392 SQ-A-06 F-9 §14.2 5xx → unavailable, cause server_error', async () => {
    for (const status of [500, 502, 503, 504]) {
      stub(new Response('boom', { status }));
      expect(await createExecutionClient(testConfig(), 't').submit(env(), 'k')).toEqual({
        status: 'unavailable',
        cause: 'server_error',
      });
    }
  });

  it('C-349 C-392 SQ-A-06 F-9 §14.2 network failure → unavailable, cause timeout', async () => {
    stub(new TypeError('fetch failed'));
    expect(await createExecutionClient(testConfig(), 't').submit(env(), 'k')).toEqual({
      status: 'unavailable',
      cause: 'timeout',
    });
  });

  it('C-349 C-392 SQ-A-06 F-9 §14.2 timeout (execution.timeout_ms) → unavailable, cause timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')));
          }),
      ),
    );
    const cfg = testConfig();
    cfg.execution.timeout_ms = 30;
    expect(await createExecutionClient(cfg, 't').submit(env(), 'k')).toEqual({
      status: 'unavailable',
      cause: 'timeout',
    });
  });

  it('C-349 SQ-A-06 F-9 §14.2 a 3xx (redirect refused / not a success) → unavailable, cause server_error', async () => {
    stub(new Response(null, { status: 302, headers: { Location: 'http://evil.invalid/' } }));
    expect(await createExecutionClient(testConfig(), 't').submit(env(), 'k')).toEqual({
      status: 'unavailable',
      cause: 'server_error',
    });
  });

  it('C-152 C-349 §14.2 two submits of the same envelope send the same Idempotency-Key header', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('x', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    const client = createExecutionClient(testConfig(), 't');
    const e = env();
    expect(await client.submit(e, 'req_aaaaaaaaaaaa')).toEqual({ status: 'unavailable', cause: 'server_error' });
    expect(await client.submit(e, 'req_aaaaaaaaaaaa')).toEqual({ status: 'accepted' });
    const headers = f.mock.calls.map((c) => (c[1] as RequestInit).headers as Record<string, string>);
    expect(headers[0]?.['Idempotency-Key']).toBe('req_aaaaaaaaaaaa');
    expect(headers[1]?.['Idempotency-Key']).toBe('req_aaaaaaaaaaaa');
    expect((f.mock.calls[0]?.[1] as RequestInit).body).toBe((f.mock.calls[1]?.[1] as RequestInit).body);
  });

  it('C-349 S12 with the real client: a 4xx body message surfaces as EXECUTION_REJECTED, a 503 as EXECUTION_UNAVAILABLE', async () => {
    const ctx = ctxD({ balances: usdc('0', '80', '0') });
    ctx.exec = createExecutionClient(ctx.config, 'tok') as never;
    const plan = [planI(0, mintAmount(ctx, '50'), addAradhya(ctx), BASE)];
    stub(new Response(JSON.stringify({ message: 'paused' }), { status: 403 }));
    expectError(await handoff(ctx, plan), 'EXECUTION_REJECTED', { message: 'paused' });
    expect(ctx.repos.tables.db6[0]?.status).toBe('failed');
    // A terminal 4xx is not retryable through the manager. Use a separate request for the 503 branch.
    const unavailable = ctxD({ balances: usdc('0', '80', '0') });
    unavailable.exec = createExecutionClient(unavailable.config, 'tok') as never;
    stub(new Response('', { status: 503 }));
    expectError(
      await handoff(unavailable, [planI(0, mintAmount(unavailable, '50'), addAradhya(unavailable), BASE)]),
      'EXECUTION_UNAVAILABLE',
    );
    expect(unavailable.repos.tables.db6[0]?.status).toBe('pending');
    expect(ctx.repos.tables.db8_history).toEqual([]);
    expect(unavailable.repos.tables.db8_history).toEqual([]);
  });
});

// referenced to keep shared helper imports tidy
void [addAmount, sched];
