// Ported from lab src/flex.handoff.test.ts (TEST_MAP §4.4, 29 cases), run against the real translator, plus new cases
// for what the test translator did not cover. Fixtures are mutated freely, hence the `any`.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { formatUnits, parseUnits } from 'viem';
import { describe, expect, it } from 'vitest';
import { executionsOf } from '../../src/chain/redeem.v2.js';
import { checkEnvelope } from '../../src/mapping/check.js';
import { intentIdFor, toPlan } from '../../src/mapping/to-plan.js';
import { MAX_STEPS_PER_PLAN, PlanSchema } from '../../src/schemas/bridge.v2.js';
import { MAX_RECIPIENTS, MAX_RECIPIENTS_AUTOMATED, USDC, type Intent } from '../../src/schemas/intent.v2.js';

const WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ARADHYA = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const MIHIR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const ALICE = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const BOB = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';
const FEE_TO = '0x976EA74026E726554dB657fA54763abd0C3a0aa9';
const PLAN_ID = '0x' + 'ab'.repeat(32);
const DELEGATION_HASH = '0x' + 'cd'.repeat(32);

const usdc = (v: string) => ({ value: v, base_units: parseUnits(v, 6).toString(), decimals: 6 });
const eth = (v: string) => ({ value: v, base_units: parseUnits(v, 18).toString(), decimals: 18 });
const now = Math.floor(Date.now() / 1000);
const env = (intents: any[]) => ({
  version: '2',
  request_id: 'req_0123456789ab',
  wallet_address: WALLET,
  created_at: new Date().toISOString(),
  intents,
});

const j0: any = {
  intent_id: 'j',
  step: 0,
  token: 'USDC',
  source_token_address: USDC[421614],
  dest_token_address: USDC[84532],
  source_chain_id: 421614,
  dest_chain_id: 84532,
  amount: usdc('10'),
  receiver: 'self',
  fee_max_eth: '0.002',
  funds_steps: [1],
};
const i1: any = {
  intent_id: 'i',
  step: 1,
  depends_on: [0],
  token: 'USDC',
  token_address: USDC[84532],
  chain_id: 84532,
  recipients: [{ recipient: ARADHYA, amount: usdc('40') }],
};
const i2: any = {
  intent_id: 'i',
  step: 2,
  depends_on: [],
  token: 'USDC',
  token_address: USDC[421614],
  chain_id: 421614,
  recipients: [{ recipient: MIHIR, amount: usdc('20') }],
};
const E3 = env([j0, i1, i2]);
const group: any = {
  intent_id: 'i',
  step: 0,
  depends_on: [],
  token: 'USDC',
  token_address: USDC[84532],
  chain_id: 84532,
  recipients: [
    { recipient: ALICE, amount: usdc('10') },
    { recipient: BOB, amount: usdc('10') },
  ],
};
const E4 = env([group]);
const kLeg = (start: number, runs: number): any => ({
  intent_id: 'k',
  step: 0,
  depends_on: [],
  autopay_id: 'ap_0123456789ab',
  token: 'USDC',
  token_address: USDC[84532],
  chain_id: 84532,
  recipients: [{ recipient: MIHIR, amount: usdc('10') }],
  fee: { to: FEE_TO, amount: usdc('0.05') },
  schedule: {
    start_at: start,
    interval_seconds: 604800,
    max_runs: runs,
    late_window_seconds: 3600,
    end_at: start + 604800 * (runs - 1) + 3600,
  },
  limits: { max_per_run: usdc('10.05'), max_total: usdc(formatUnits(parseUnits('10.05', 6) * BigInt(runs), 6)) },
  executor: 'chainlink-cre',
});
const E6 = env([kLeg(now + 86400, 8)]);
const cancel: any = {
  intent_id: 'l',
  step: 0,
  autopay_id: 'ap_0123456789ab',
  chain_id: 84532,
  plan_id: PLAN_ID,
};
const E7 = env([cancel]);
const A64 = env([
  { ...kLeg(now + 86400, 4), step: 0 },
  { ...kLeg(now + 4 * 86400, 4), step: 1, autopay_id: 'ap_ba9876543210' },
]);
const ETHpay = env([
  {
    intent_id: 'i',
    step: 0,
    depends_on: [],
    token: 'ETH',
    token_address: null,
    chain_id: 11155111,
    recipients: [{ recipient: MIHIR, amount: eth('0.01') }],
  },
]);
const without = (o: any, key: string) => {
  const c = structuredClone(o);
  delete c[key];
  return c;
};
const k8 = kLeg(now + 86400, 8);
const options = { delegationHashes: { 0: DELEGATION_HASH as `0x${string}` } };

describe('accepted by both checks', () => {
  it.each([
    ['E3 [j 10, i 40, i 20]', E3],
    ['E4 group as one i', E4],
    ['E6 weekly autopay with fee', E6],
    ['E7 cancel with plan_id', E7],
    ['A-64 two legs MON/THU', A64],
    ['ETH one-time payment', ETHpay],
  ])('%s', (_name, envelope) => {
    expect(checkEnvelope(envelope, options)).toMatchObject({ ok: true });
  });
});

describe('rejected by the §12.5 schema', () => {
  it.each([
    ['ETH bridge', env([{ ...j0, token: 'ETH', source_token_address: null, dest_token_address: null }])],
    [
      'old k: prefund + cre_job',
      env([
        {
          ...k8,
          prefund: usdc('80'),
          cre_job: { trigger: 'cron', cron: '0 10 * * 5', timezone: 'Asia/Kolkata', interval: 1 },
        },
      ]),
    ],
    ['k without a fee', env([without(k8, 'fee')])],
    [
      'old l: delegate_address + refund_remaining',
      env([{ ...cancel, delegate_address: WALLET, refund_remaining: true }]),
    ],
    ['l without plan_id', env([without(cancel, 'plan_id')])],
    [
      'old i: single amount and recipient',
      env([{ ...without(group, 'recipients'), amount: usdc('10'), recipient: MIHIR }]),
    ],
    [
      'group of 101',
      env([{ ...group, recipients: Array.from({ length: 101 }, () => ({ recipient: ALICE, amount: usdc('1') })) }]),
    ],
    ['j without fee_max_eth', env([without(j0, 'fee_max_eth')])],
    ['k interval below 60 s', env([{ ...k8, schedule: { ...k8.schedule, interval_seconds: 30 } }])],
    ['k with a name field', env([{ ...k8, recipient_name: 'Mihir' }])],
    ['version 1 envelope', { ...E6, version: '1' }],
  ])('%s', (_name, envelope) => {
    expect(checkEnvelope(envelope, options)).toMatchObject({ ok: false, stage: 'schema' });
  });
});

describe('valid envelope, rejected by the verified plan', () => {
  it.each([
    ['k end_at cuts off runs', env([{ ...k8, schedule: { ...k8.schedule, end_at: now + 86400 + 3600 } }])],
    [
      'k late window longer than interval',
      env([
        {
          ...k8,
          schedule: {
            ...k8.schedule,
            interval_seconds: 600,
            late_window_seconds: 3600,
            end_at: now + 86400 + 600 * 7 + 3600,
          },
        },
      ]),
    ],
    ['k start in the past', env([kLeg(now - 86400, 8)])],
    ['k max_total too low', env([{ ...k8, limits: { max_per_run: usdc('10.05'), max_total: usdc('80') } }])],
    ['k fee collector is the payee', env([{ ...k8, fee: { to: MIHIR, amount: usdc('0.05') } }])],
    [
      'i pays the zero address',
      env([
        { ...group, recipients: [{ recipient: '0x0000000000000000000000000000000000000000', amount: usdc('10') }] },
      ]),
    ],
    [
      'i duplicate recipient',
      env([
        {
          ...group,
          recipients: [
            { recipient: ALICE, amount: usdc('10') },
            { recipient: ALICE, amount: usdc('10') },
          ],
        },
      ]),
    ],
    [
      'j lands on the wrong chain for its payment',
      env([{ ...j0, dest_chain_id: 11155111, dest_token_address: USDC[11155111] }, i1, i2]),
    ],
    ['j fee cap above 0.01 ETH', env([{ ...j0, fee_max_eth: '0.05' }, i1, i2])],
    ['USDC address not the registered one', env([{ ...group, token_address: USDC[11155111] }])],
  ])('%s', (_name, envelope) => {
    expect(checkEnvelope(envelope, options)).toMatchObject({ ok: false, stage: 'plan' });
  });
});

describe("README's own numbers", () => {
  it('E6 start and end timestamps', () => {
    const start = 1793939400;
    const end = start + 604800 * 7 + 3600;
    expect(end).toBe(1798176600);
    expect(new Date(start * 1000).toISOString()).toBe('2026-11-06T04:30:00.000Z');
    expect(new Date(end * 1000).toISOString()).toBe('2026-12-25T05:30:00.000Z');
  });
  it('E6 max_total 80.4 and A-10 need 1,567.8, in base units', () => {
    const perRun = parseUnits('10.05', 6);
    expect(perRun * 8n).toBe(parseUnits('80.4', 6));
    expect(perRun * 52n * 3n).toBe(parseUnits('1567.8', 6));
  });
});

describe('fields the test translator did not check (new)', () => {
  const stageOf = (envelope: unknown) => {
    const r = checkEnvelope(envelope, options);
    return r.ok ? 'ok' : r.stage;
  };

  it('rejects base_units that disagree with value', () => {
    const wrong = { ...usdc('10'), base_units: '1000000000' };
    expect(stageOf(env([{ ...group, recipients: [{ recipient: ALICE, amount: wrong }] }]))).toBe('consistency');
    expect(stageOf(env([{ ...j0, amount: wrong }, i1, i2]))).toBe('consistency');
    expect(stageOf(env([{ ...k8, recipients: [{ recipient: MIHIR, amount: wrong }] }]))).toBe('consistency');
    expect(stageOf(env([{ ...k8, fee: { to: FEE_TO, amount: wrong } }]))).toBe('consistency');
  });

  it('rejects decimals that do not match the token', () => {
    const r = { recipient: ALICE, amount: { value: '10', base_units: parseUnits('10', 18).toString(), decimals: 18 } };
    expect(stageOf(env([{ ...group, recipients: [r] }]))).toBe('consistency');
  });

  it('rejects more decimals than the token has, instead of rounding them', () => {
    const r = { recipient: ALICE, amount: { value: '1.0000001', base_units: '1000000', decimals: 6 } };
    expect(stageOf(env([{ ...group, recipients: [r] }]))).toBe('consistency');
  });

  it('rejects an ETH intent that carries a token address', () => {
    const [x] = ETHpay.intents;
    expect(stageOf(env([{ ...x, token_address: USDC[11155111] }]))).toBe('consistency');
  });

  it('rejects a bridge whose destination token is not the registered USDC', () => {
    expect(stageOf(env([{ ...j0, dest_token_address: USDC[421614] }, i1, i2]))).toBe('consistency');
  });

  it('rejects an l when its delegation hash has not been read', () => {
    expect(checkEnvelope(E7)).toMatchObject({ ok: false, stage: 'consistency' });
  });

  it('keeps 18 decimals in an ETH group total (the test translator truncated to 6)', () => {
    const envelope = env([
      {
        ...ETHpay.intents[0],
        recipients: [
          { recipient: ALICE, amount: eth('0.000000000000000001') },
          { recipient: BOB, amount: eth('0.000000000000000002') },
        ],
      },
    ]);
    const r = checkEnvelope(envelope);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const step = r.plan.steps[0];
      expect(step?.kind === 'payment' && step.intent.limits.maxPerRun).toBe('0.000000000000000003');
    }
  });
});

describe('rejection output never carries values (§15)', () => {
  it.each([
    ['schema', { ...E6, version: '1' }],
    [
      'consistency',
      env([{ ...group, recipients: [{ recipient: ALICE, amount: { ...usdc('10'), base_units: '7' } }] }]),
    ],
    ['plan', env([{ ...k8, limits: { max_per_run: usdc('10.05'), max_total: usdc('80') } }])],
  ])('%s', (_stage, envelope) => {
    const r = checkEnvelope(envelope);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = `${r.message} ${r.paths.join(' ')}`;
      expect(text).not.toMatch(/0x[0-9a-fA-F]{4}/);
      expect(r.message).not.toMatch(/\d/);
    }
  });
});

describe('intentIdFor (provisional, OQ-09)', () => {
  it('is stable for a step, differs across steps and requests', () => {
    expect(intentIdFor('req_0123456789ab', 1)).toBe(intentIdFor('req_0123456789ab', 1));
    expect(intentIdFor('req_0123456789ab', 1)).not.toBe(intentIdFor('req_0123456789ab', 2));
    expect(intentIdFor('req_0123456789ab', 1)).not.toBe(intentIdFor('req_ba9876543210', 1));
  });
  it('gives the same intent ids on a repeat of the same envelope', () => {
    const a = checkEnvelope(E3);
    const b = checkEnvelope(structuredClone(E3));
    expect(a.ok && b.ok && a.plan.steps.map((s) => s.intent.intentId)).toEqual(
      a.ok && b.ok && b.plan.steps.map((s) => s.intent.intentId),
    );
  });
});

describe('envelope changes (docs/wallet/ARCHITECTURE_CHANGES.md)', () => {
  const stageOf = (envelope: unknown) => {
    const r = checkEnvelope(envelope, options);
    return r.ok ? 'ok' : r.stage;
  };
  const address = (n: number) => `0x${(n + 1).toString(16).padStart(40, '0')}`;
  const payees = (count: number) =>
    Array.from({ length: count }, (_, n) => ({ recipient: address(n), amount: usdc(String(n + 1)) }));
  /** A payroll autopay: each person's own amount, one fee, one plan. */
  const payroll = (count: number, runs = 4) => {
    const total = payees(count).reduce((sum, p) => sum + BigInt(p.amount.base_units), 0n);
    const perRun = total + parseUnits('0.05', 6);
    return {
      ...kLeg(now + 86400, runs),
      recipients: payees(count),
      limits: { max_per_run: usdc(formatUnits(perRun, 6)), max_total: usdc(formatUnits(perRun * BigInt(runs), 6)) },
    };
  };

  describe('C-1: k pays a list', () => {
    it('accepts 50 people with different amounts, and turns them into one batch ending in the fee', () => {
      const r = checkEnvelope(env([payroll(50)]));
      expect(r.ok).toBe(true);
      if (r.ok) {
        const executions = executionsOf(r.plan.steps[0]?.intent as Intent);
        expect(executions).toHaveLength(51);
        expect(executions.at(-1)?.callData.toLowerCase()).toContain(FEE_TO.slice(2).toLowerCase());
      }
    });
    it('rejects 51 people at the schema', () => {
      expect(stageOf(env([{ ...payroll(50), recipients: payees(51) }]))).toBe('schema');
    });
    it('rejects an empty list', () => {
      expect(stageOf(env([{ ...k8, recipients: [] }]))).toBe('schema');
    });
    it('rejects the old single recipient shape', () => {
      const { recipients: _recipients, ...rest } = k8;
      expect(stageOf(env([{ ...rest, recipient: MIHIR, amount_per_payment: usdc('10') }]))).toBe('schema');
    });
    it('rejects limits that do not cover everyone', () => {
      const low = { ...payroll(2), limits: { max_per_run: usdc('3'), max_total: usdc('100') } };
      expect(stageOf(env([low]))).toBe('plan');
    });
    it('rejects the same person twice', () => {
      const twice = [
        { recipient: ALICE, amount: usdc('1') },
        { recipient: ALICE, amount: usdc('1') },
      ];
      expect(stageOf(env([{ ...k8, recipients: twice }]))).toBe('plan');
    });
    it('rejects the fee collector as a payee', () => {
      const r = [{ recipient: FEE_TO, amount: usdc('10') }];
      expect(stageOf(env([{ ...k8, recipients: r }]))).toBe('plan');
    });
    it('checks every amount against its base_units', () => {
      const wrong = [
        { recipient: ALICE, amount: usdc('1') },
        { recipient: BOB, amount: { ...usdc('1'), base_units: '7' } },
      ];
      expect(checkEnvelope(env([{ ...k8, recipients: wrong }]))).toMatchObject({
        stage: 'consistency',
        paths: ['/intents/0.recipients[1].amount.base_units'],
      });
    });
  });

  describe('C-2: l carries no recipient', () => {
    it('rejects the old field', () => {
      expect(stageOf(env([{ ...cancel, recipient: MIHIR }]))).toBe('schema');
    });
  });

  describe('C-3: plan size', () => {
    const payment = (step: number) => ({
      ...group,
      step,
      recipients: [{ recipient: address(step), amount: usdc('1') }],
    });
    const steps = (count: number) => env(Array.from({ length: count }, (_, n) => payment(n)));

    it('accepts the worst case the limit is sized for: 3 j + 6 i + 7 k legs', () => {
      const j = (step: number, source: 11155111 | 421614) => ({
        ...j0,
        step,
        source_chain_id: source,
        source_token_address: USDC[source],
        funds_steps: [3],
      });
      const i = [84532, 84532, 11155111, 11155111, 421614, 421614].map((chain, n) => ({
        intent_id: 'i',
        step: n + 3,
        depends_on: n === 0 ? [0, 1, 2] : [],
        token: n % 2 === 0 ? 'USDC' : 'ETH',
        token_address: n % 2 === 0 ? USDC[chain as 84532] : null,
        chain_id: chain,
        recipients: [{ recipient: address(n), amount: n % 2 === 0 ? usdc('1') : eth('0.01') }],
      }));
      const k = Array.from({ length: 7 }, (_, n) => ({
        ...k8,
        step: n + 9,
        autopay_id: `ap_${n.toString(16).padStart(12, '0')}`,
      }));
      expect(stageOf(env([j(0, 421614), j(1, 11155111), j(2, 421614), ...i, ...k]))).toBe('ok');
    });
    it('accepts 9 separate payments, which the old limit of 8 refused', () => {
      expect(stageOf(steps(9))).toBe('ok');
    });
    it('accepts 16 and rejects 17 at the schema', () => {
      expect(stageOf(steps(16))).toBe('ok');
      expect(stageOf(steps(17))).toBe('schema');
    });
    it('PlanSchema enforces the same limit on its own', () => {
      expect(PlanSchema.safeParse(toPlan(steps(16) as never)).success).toBe(true);
      expect(PlanSchema.safeParse(toPlan(steps(17) as never)).success).toBe(false);
    });
  });

  describe('C-4: one spelling per amount', () => {
    const amount = (value: string) => ({ value, base_units: parseUnits(value, 6).toString(), decimals: 6 });
    it.each(['10.50', '10.0', '010', '00.5'])('rejects %s at the schema', (value) => {
      expect(stageOf(env([{ ...group, recipients: [{ recipient: ALICE, amount: amount(value) }] }]))).toBe('schema');
    });
    it.each(['10', '10.5', '0.05', '100'])('accepts %s', (value) => {
      expect(stageOf(env([{ ...group, recipients: [{ recipient: ALICE, amount: amount(value) }] }]))).toBe('ok');
    });
  });

  describe('C-5: timestamps have an upper bound', () => {
    it.each([
      ['start_at', { start_at: 9e15, end_at: 9e15 + 1e7 }],
      ['end_at', { end_at: 9e15 }],
    ])('rejects a far-future %s as a 4xx instead of throwing, which would become a retried 5xx', (_name, times) => {
      const envelope = env([{ ...k8, schedule: { ...k8.schedule, ...times } }]);
      expect(() => checkEnvelope(envelope)).not.toThrow();
      expect(stageOf(envelope)).toBe('schema');
    });
  });

  describe('the JSON schema and the verified schemas agree on limits', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../../src/schemas/handoff-envelope.schema.json', import.meta.url), 'utf8'),
    );
    it('steps', () => expect(schema.properties.intents.maxItems).toBe(MAX_STEPS_PER_PLAN));
    it('one-time recipients', () => expect(schema.$defs.payment_i.properties.recipients.maxItems).toBe(MAX_RECIPIENTS));
    it('automated recipients', () =>
      expect(schema.$defs.autopay_k.properties.recipients.maxItems).toBe(MAX_RECIPIENTS_AUTOMATED));
  });
});
