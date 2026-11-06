// Ported from lab src/schema.test.ts (TEST_MAP §4.1, 43 cases). Fixtures are mutated freely, hence the `any`.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { IntentSchema, USDC } from '../../src/schemas/intent.v2.js';

const ME = '0x05d156A72ad376d808160964B04c10cd68b9d069';
const ALICE = '0x000000000000000000000000000000000000a11c';
const BOB = '0x0000000000000000000000000000000000000b0b';
const FEE = '0x000000000000000000000000000000000000fee0';
const in1h = new Date(Date.now() + 3600e3).toISOString();

const once = { type: 'once', startAt: null, interval: null, maxRuns: null, endAt: null, lateWindow: null };
const userExample = {
  intentId: '3f8a1c2e-7b4d-4e6f-9a1b-2c3d4e5f6a7b',
  version: 1,
  chainId: 11155111,
  from: ME,
  asset: { type: 'native', token: null, decimals: 18 },
  recipients: [
    { to: ALICE, amount: '1.5' },
    { to: BOB, amount: '0.5' },
  ],
  atomic: true,
  schedule: once,
  execution: { mode: 'immediate', executor: null, fee: null },
  limits: { maxPerRun: '2', maxTotal: null },
};
const recurring = {
  ...userExample,
  intentId: '7c2e9b1a-4d3f-4a8e-b6c5-1d2e3f4a5b6c',
  recipients: [
    { to: ALICE, amount: '0.0015' },
    { to: BOB, amount: '0.0005' },
  ],
  schedule: { type: 'recurring', startAt: in1h, interval: 60, maxRuns: 3, endAt: null, lateWindow: 60 },
  execution: { mode: 'automated', executor: 'chainlink-cre', fee: { to: FEE, amount: '0.0001' } },
  limits: { maxPerRun: '0.0021', maxTotal: '0.0063' },
};
const usdcBase = {
  ...userExample,
  chainId: 84532,
  asset: { type: 'erc20', token: USDC[84532], decimals: 6 },
  recipients: [
    { to: ALICE, amount: '10' },
    { to: BOB, amount: '5' },
  ],
  limits: { maxPerRun: '15', maxTotal: null },
};
const usdcSep = { ...usdcBase, chainId: 11155111, asset: { type: 'erc20', token: USDC[11155111], decimals: 6 } };
const mut = (f: (x: any) => void, b: any = recurring) => {
  const c = structuredClone(b);
  f(c);
  return c;
};
const many = (n: number, amount: string) =>
  Array.from({ length: n }, (_, k) => ({ to: '0x' + (0xa000 + k).toString(16).padStart(40, '0'), amount }));

const original: [string, unknown, boolean][] = [
  ['user example (once, immediate)', userExample, true],
  ['recurring, automated', recurring, true],
  ['JSON with // comments as pasted', '<not JSON>', false],
  ['recipients sum > maxPerRun', mut((c) => (c.recipients[0].amount = '0.0016')), false],
  ['19 decimals on 18-decimal asset', mut((c) => (c.recipients[0].amount = '0.0000000000000000001')), false],
  ['duplicate recipient', mut((c) => (c.recipients[1].to = ALICE)), false],
  ['native with token set', mut((c) => (c.asset.token = BOB)), false],
  ['erc20 without token', mut((c) => (c.asset.type = 'erc20')), false],
  ['recurring without interval', mut((c) => (c.schedule.interval = null)), false],
  ['recurring with no maxRuns and no endAt', mut((c) => (c.schedule.maxRuns = null)), false],
  ['recurring with maxTotal null', mut((c) => (c.limits.maxTotal = null)), false],
  ['maxTotal < sum x maxRuns', mut((c) => (c.limits.maxTotal = '0.005')), false],
  ['immediate + recurring', mut((c) => (c.execution = { mode: 'immediate', executor: null, fee: null })), false],
  ['automated without executor', mut((c) => (c.execution.executor = null)), false],
  ['once with interval set', mut((c) => (c.schedule.interval = 60), userExample), false],
  ['non-atomic multi-recipient', mut((c) => (c.atomic = false)), false],
  ['unknown extra field', mut((c) => (c.memo = 'x')), false],
  ['amount as number', mut((c) => (c.recipients[0].amount = 0.0015)), false],
  ['bad address', mut((c) => (c.recipients[0].to = '0xAlice')), false],
  ['chainId mainnet', mut((c) => (c.chainId = 1)), false],
];

const fromOnchainFailures: [string, unknown, boolean][] = [
  ['Base Sepolia USDC payment', usdcBase, true],
  [
    'Arbitrum Sepolia USDC payment',
    mut((c) => {
      c.chainId = 421614;
      c.asset.token = USDC[421614];
    }, usdcBase),
    true,
  ],
  [
    'B9 zero-address recipient',
    mut((c) => (c.recipients[0].to = '0x0000000000000000000000000000000000000000'), userExample),
    false,
  ],
  [
    'EIP-55 mixed-case address with a wrong checksum',
    mut((c) => (c.recipients[0].to = '0x000000000000000000000000000000000000A11C'), userExample),
    false,
  ],
  [
    'B1 erc20 with an unregistered token',
    mut((c) => (c.asset.token = '0x998abeb3e57409262ae5b751f60747921b33613e'), usdcSep),
    false,
  ],
  ['B1 USDC declared with 18 decimals', mut((c) => (c.asset.decimals = 18), usdcSep), false],
  ['B1 recipient is the token contract', mut((c) => (c.recipients[1].to = USDC[11155111]), usdcSep), false],
  ['B7a/C1 automated with startAt null', mut((c) => (c.schedule.startAt = null)), false],
  ['B7a startAt in the past', mut((c) => (c.schedule.startAt = new Date(Date.now() - 86400e3).toISOString())), false],
  [
    'B7b one-time automated payment tomorrow',
    mut((c) => {
      c.schedule = { ...once, startAt: new Date(Date.now() + 86400e3).toISOString() };
      c.limits.maxTotal = null;
    }),
    true,
  ],
  [
    'C2/C6 recurring with endAt but no maxRuns',
    mut((c) => {
      c.schedule.maxRuns = null;
      c.schedule.endAt = new Date(Date.now() + 7200e3).toISOString();
    }),
    false,
  ],
  ['C6 recurring without lateWindow', mut((c) => (c.schedule.lateWindow = null)), false],
  ['C6 lateWindow longer than interval', mut((c) => (c.schedule.lateWindow = 120)), false],
  [
    'C6 endAt cuts off promised slots',
    mut((c) => (c.schedule.endAt = new Date(Date.now() + 3600e3 + 30e3).toISOString())),
    false,
  ],
  [
    'longer than 52 weeks',
    mut((c) => {
      c.schedule.interval = 7 * 86400;
      c.schedule.maxRuns = 60;
      c.schedule.lateWindow = 3600;
      c.limits.maxTotal = '1';
    }),
    false,
  ],
  ['B8 automated without a fee', mut((c) => (c.execution.fee = null)), false],
  ['B8 immediate with a fee', mut((c) => (c.execution.fee = { to: FEE, amount: '0.01' }), userExample), false],
  ['B8 maxPerRun covers recipients but not the fee', mut((c) => (c.limits.maxPerRun = '0.002')), false],
  ['B8 maxTotal covers payments but not fees', mut((c) => (c.limits.maxTotal = '0.006')), false],
  [
    'B12 one-time group, 100 recipients',
    mut((c) => {
      c.recipients = many(100, '1');
      c.limits.maxPerRun = '100';
    }, userExample),
    true,
  ],
  [
    'B12 one-time group, 101 recipients',
    mut((c) => {
      c.recipients = many(101, '1');
      c.limits.maxPerRun = '101';
    }, userExample),
    false,
  ],
  [
    'B12 autopay to 50 recipients',
    mut((c) => {
      c.recipients = many(50, '0.0001');
      c.limits.maxPerRun = '0.0051';
      c.limits.maxTotal = '0.0153';
    }),
    true,
  ],
  [
    'B12 autopay to 51 recipients',
    mut((c) => {
      c.recipients = many(51, '0.0001');
      c.limits.maxPerRun = '0.0052';
      c.limits.maxTotal = '0.0156';
    }),
    false,
  ],
];

describe('IntentSchema (TEST_MAP §4.1)', () => {
  it('has all 43 cases', () => expect(original.length + fromOnchainFailures.length).toBe(43));
  it.each(original)('%s', (_name, input, accepted) => {
    expect(IntentSchema.safeParse(input).success).toBe(accepted);
  });
  it.each(fromOnchainFailures)('%s', (_name, input, accepted) => {
    expect(IntentSchema.safeParse(input).success).toBe(accepted);
  });
});
