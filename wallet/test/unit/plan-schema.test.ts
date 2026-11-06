// Ported from lab src/plan.test.ts (5), the P cases of src/ccip.test.ts (13) and src/scenarios.test.ts (5).
// TEST_MAP §4.2, §4.3. Fixtures are mutated freely, hence the `any`.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { PlanSchema } from '../../src/schemas/bridge.v2.js';
import { USDC } from '../../src/schemas/intent.v2.js';

const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ALICE = '0x000000000000000000000000000000000000a11c';
const BOB = '0x0000000000000000000000000000000000000b0b';
const FEE = '0x000000000000000000000000000000000000fee0';
const ATTACKER = '0x000000000000000000000000000000000000bad0';
const PAYEE = '0x00000000000000000000000000000000000ca401';
const REQUEST = 'req_0123456789ab';
const ONCE = { type: 'once', startAt: null, interval: null, maxRuns: null, endAt: null, lateWindow: null };
const ETH = { type: 'native', token: null, decimals: 18 };
const usdc = (c: 11155111 | 84532 | 421614) => ({ type: 'erc20', token: USDC[c], decimals: 6 });
const in1h = () => new Date(Date.now() + 3600e3).toISOString();

const bridge = (o: any = {}) => ({
  intentId: crypto.randomUUID(),
  version: 1,
  from: ME,
  sourceChainId: 421614,
  destChainId: 84532,
  asset: usdc(421614),
  amount: '10',
  receiver: ME,
  fee: { payIn: 'native', max: '0.002' },
  execution: { mode: 'immediate' },
  ...o,
});
const pay = (o: any = {}) => ({
  intentId: crypto.randomUUID(),
  version: 1,
  chainId: 84532,
  from: ME,
  asset: usdc(84532),
  recipients: [{ to: ALICE, amount: '40' }],
  atomic: true,
  schedule: ONCE,
  execution: { mode: 'immediate', executor: null, fee: null },
  limits: { maxPerRun: '40', maxTotal: null },
  ...o,
});
const cancel = (o: any = {}) => ({
  intentId: crypto.randomUUID(),
  version: 1,
  from: ME,
  chainId: 84532,
  autopayId: 'ap_0123456789ab',
  delegationHash: '0x' + 'ab'.repeat(32),
  execution: { mode: 'immediate' },
  ...o,
});
const payArb = () =>
  pay({
    chainId: 421614,
    asset: usdc(421614),
    recipients: [{ to: BOB, amount: '20' }],
    limits: { maxPerRun: '20', maxTotal: null },
  });
const plan = (steps: any[]) => ({ requestId: REQUEST, steps });

describe('plan cases (TEST_MAP §4.2, 5)', () => {
  const autopay = pay({
    recipients: [
      { to: ALICE, amount: '10' },
      { to: BOB, amount: '5' },
    ],
    schedule: { type: 'recurring', startAt: in1h(), interval: 604800, maxRuns: 10, endAt: null, lateWindow: 3600 },
    execution: { mode: 'automated', executor: 'chainlink-cre', fee: { to: FEE, amount: '0.05' } },
    limits: { maxPerRun: '15.05', maxTotal: '150.5' },
  });
  it.each<[string, unknown, boolean]>([
    [
      'README worked example [j, i, i]',
      plan([
        { step: 0, kind: 'bridge', funds: [1], intent: bridge() },
        { step: 1, kind: 'payment', dependsOn: [0], intent: pay() },
        { step: 2, kind: 'payment', dependsOn: [], intent: payArb() },
      ]),
      true,
    ],
    [
      '[j, k] bridge first, then weekly autopay',
      plan([
        { step: 0, kind: 'bridge', funds: [1], intent: bridge({ amount: '150.5' }) },
        { step: 1, kind: 'payment', dependsOn: [0], intent: autopay },
      ]),
      true,
    ],
    ['[l] cancel', plan([{ step: 0, kind: 'cancel', intent: cancel() }]), true],
    [
      'cancel with a bad delegation hash',
      plan([{ step: 0, kind: 'cancel', intent: cancel({ delegationHash: '0x12' }) }]),
      false,
    ],
    [
      'bridge listed after a cancel',
      plan([
        { step: 0, kind: 'cancel', intent: cancel() },
        { step: 1, kind: 'bridge', funds: [2], intent: bridge() },
        { step: 2, kind: 'payment', dependsOn: [1], intent: pay() },
      ]),
      false,
    ],
  ])('%s', (_name, input, accepted) => {
    expect(PlanSchema.safeParse(input).success).toBe(accepted);
  });
});

describe('P cases (TEST_MAP §4.2, 13)', () => {
  const pBridge = (o: any = {}) =>
    bridge({ sourceChainId: 11155111, destChainId: 84532, asset: usdc(11155111), amount: '10.2', ...o });
  const readme = plan([
    { step: 0, kind: 'bridge', funds: [1], intent: pBridge() },
    { step: 1, kind: 'payment', dependsOn: [0], intent: pay() },
    { step: 2, kind: 'payment', dependsOn: [], intent: payArb() },
  ]);
  const m = (f: (x: any) => void, b: any = readme) => {
    const c = structuredClone(b);
    f(c);
    return c;
  };
  it.each<[string, unknown, boolean]>([
    ['README worked example [j, i, i]', readme, true],
    ['bridge to someone else', m((c) => (c.steps[0].intent.receiver = ATTACKER)), false],
    ['bridge source = destination', m((c) => (c.steps[0].intent.destChainId = 11155111)), false],
    ['bridge with a non-registered token', m((c) => (c.steps[0].intent.asset.token = USDC[84532])), false],
    ['ETH bridge', m((c) => (c.steps[0].intent.asset = ETH)), false],
    ['fee cap above 0.01 ETH', m((c) => (c.steps[0].intent.fee.max = '0.5')), false],
    [
      'bridge after the payment it funds',
      m((c) => {
        c.steps = [
          { ...c.steps[1], step: 0, dependsOn: [] },
          { ...c.steps[0], step: 1, funds: [0] },
        ];
      }),
      false,
    ],
    [
      'bridge lands on Base, funded payment is on Arbitrum',
      m((c) => {
        c.steps[0].funds = [2];
        c.steps[2].dependsOn = [0];
        c.steps[1].dependsOn = [];
      }),
      false,
    ],
    ['payment does not wait for its bridge', m((c) => (c.steps[1].dependsOn = [])), false],
    [
      'bridged payment in ETH instead of USDC',
      m((c) => {
        c.steps[1].intent.asset = ETH;
        c.steps[1].intent.recipients[0].amount = '0.01';
        c.steps[1].intent.limits.maxPerRun = '0.01';
      }),
      false,
    ],
    [
      'steps from two different accounts',
      m((c) => (c.steps[2].intent.from = '0x000000000000000000000000000000000000c0de')),
      false,
    ],
    [
      '4 bridges in one plan',
      plan([
        ...[0, 1, 2, 3].map((k) => ({ step: k, kind: 'bridge', funds: [4], intent: pBridge() })),
        { step: 4, kind: 'payment', dependsOn: [0, 1, 2, 3], intent: pay() },
      ]),
      false,
    ],
    [
      'bridge + recurring autopay on the destination',
      m((c) => {
        c.steps.pop();
        c.steps[1].intent = pay({
          schedule: { type: 'recurring', startAt: in1h(), interval: 86400, maxRuns: 3, endAt: null, lateWindow: 3600 },
          execution: { mode: 'automated', executor: 'chainlink-cre', fee: { to: FEE, amount: '0.05' } },
          recipients: [{ to: ALICE, amount: '10' }],
          limits: { maxPerRun: '10.05', maxTotal: '30.15' },
        });
      }),
      true,
    ],
  ])('%s', (_name, input, accepted) => {
    expect(PlanSchema.safeParse(input).success).toBe(accepted);
  });
});

describe('user scenarios, verified plan side (TEST_MAP §4.3, 5)', () => {
  const j = (src: number, dst: number, asset: unknown, amount: string) =>
    bridge({ sourceChainId: src, destChainId: dst, asset, amount });
  const i = (chainId: number, asset: unknown, amount: string) =>
    pay({ chainId, asset, recipients: [{ to: PAYEE, amount }], limits: { maxPerRun: amount, maxTotal: null } });
  it.each<[string, unknown, boolean]>([
    [
      '0.01 ETH from Base to Arbitrum',
      plan([
        { step: 0, kind: 'bridge', funds: [1], intent: j(84532, 421614, ETH, '0.01') },
        { step: 1, kind: 'payment', dependsOn: [0], intent: i(421614, ETH, '0.01') },
      ]),
      false,
    ],
    [
      '10 USDC from Base to Arbitrum, pay there',
      plan([
        { step: 0, kind: 'bridge', funds: [1], intent: j(84532, 421614, usdc(84532), '10') },
        { step: 1, kind: 'payment', dependsOn: [0], intent: i(421614, usdc(421614), '10') },
      ]),
      true,
    ],
    [
      'unified USDC: Base 6 + Arbitrum 4 -> 10 on Sepolia',
      plan([
        { step: 0, kind: 'bridge', funds: [2], intent: j(84532, 11155111, usdc(84532), '6') },
        { step: 1, kind: 'bridge', funds: [2], intent: j(421614, 11155111, usdc(421614), '4') },
        { step: 2, kind: 'payment', dependsOn: [0, 1], intent: i(11155111, usdc(11155111), '10') },
      ]),
      true,
    ],
    [
      'unified ETH: Base + Arbitrum -> Sepolia',
      plan([
        { step: 0, kind: 'bridge', funds: [2], intent: j(84532, 11155111, ETH, '0.01') },
        { step: 1, kind: 'bridge', funds: [2], intent: j(421614, 11155111, ETH, '0.01') },
        { step: 2, kind: 'payment', dependsOn: [0, 1], intent: i(11155111, ETH, '0.02') },
      ]),
      false,
    ],
    [
      'bridge lands on Arbitrum, payment is on Sepolia',
      plan([
        { step: 0, kind: 'bridge', funds: [1], intent: j(84532, 421614, usdc(84532), '10') },
        { step: 1, kind: 'payment', dependsOn: [0], intent: i(11155111, usdc(11155111), '10') },
      ]),
      false,
    ],
  ])('%s', (_name, input, accepted) => {
    expect(PlanSchema.safeParse(input).success).toBe(accepted);
  });
});
