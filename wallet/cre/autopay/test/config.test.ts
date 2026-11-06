import { keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { configSchema, snapshotPlans, validateConfig } from '../lib/config';
import { SIMULATION_FORWARDERS } from '../../../src/autopay/local-cre';

const source = {
  chainId: 11155111,
  selector: '16015286601757825753',
  simulation: { urlsSecret: 'SIM_URLS', quorum: 2 },
};
const local = { mode: 'local-simulation', schedule: '*/30 * * * * *', chains: [source] };
const redeem = '0x12345678';
const plan = {
  id: keccak256(redeem),
  startAt: '1000',
  interval: '60',
  lateWindow: '30',
  maxRuns: '5',
  lastSlot: '-1',
  cancelled: false,
  redeem,
};
const payment = {
  mode: 'dry-run',
  schedule: local.schedule,
  maxSimulationsPerRun: 2,
  workflow: { id: `0x${'01'.repeat(32)}`, name: `0x${'01'.repeat(10)}`, owner: `0x${'01'.repeat(20)}` },
  chains: [
    {
      ...source,
      executor: `0x${'02'.repeat(20)}`,
      forwarder: `0x${'03'.repeat(20)}`,
      deploymentBlock: '10',
      snapshot: { blockNumber: '20', blockHash: `0x${'04'.repeat(32)}`, plans: [plan] },
    },
  ],
};
describe('closed CRE configuration', () => {
  it('local testnet writes need the exact mock forwarder, one chain, wallet and pinned slot; no DON identity', () => {
    const c = {
      mode: 'testnet-broadcast',
      schedule: local.schedule,
      maxSimulationsPerRun: 1,
      walletAddress: payment.workflow.owner,
      expectedRun: { id: plan.id, slot: '0' },
      chains: [{ ...payment.chains[0], forwarder: SIMULATION_FORWARDERS[11155111] }],
    };
    expect(validateConfig(c)).toEqual(c);
    for (const override of [
      { expectedRun: undefined },
      { chains: payment.chains },
      { workflow: payment.workflow },
      { maxSimulationsPerRun: 2 },
    ])
      expect(() => validateConfig({ ...c, ...override })).toThrow();
  });
  it('accepts the receiver-free configuration and rejects any receiver/write fields in it', () => {
    expect(validateConfig(local)).toEqual(local);
    expect(() => validateConfig({ ...local, workflow: payment.workflow })).toThrow();
    expect(() => validateConfig({ ...local, chains: [{ ...source, executor: payment.chains[0].executor }] })).toThrow();
  });
  it.each([undefined, 'production', 'test', '', true])('rejects unknown or missing mode %s', (mode) => {
    expect(() => validateConfig({ ...local, mode })).toThrow();
  });
  it('requires supported chain/selector pairs, strict quorum and six cron fields', () => {
    for (const chain of [
      { ...source, chainId: 1 },
      { ...source, selector: '1' },
      { ...source, simulation: { ...source.simulation, quorum: 1 } },
    ])
      expect(() => validateConfig({ ...local, chains: [chain] })).toThrow();
    expect(() => validateConfig({ ...local, schedule: '* * * * *' })).toThrow();
  });
  it('requires real nonzero executor and identity configuration', () => {
    expect(validateConfig(payment)).toEqual(payment);
    expect(() =>
      validateConfig({ ...payment, workflow: { ...payment.workflow, id: `0x${'00'.repeat(32)}` } }),
    ).toThrow();
    expect(() =>
      validateConfig({ ...payment, chains: [{ ...payment.chains[0], executor: `0x${'00'.repeat(20)}` }] }),
    ).toThrow();
  });
  it('validates snapshot payment bytes and integers before use', () => {
    for (const changed of [
      { redeem: '0x87654321' },
      { interval: '0' },
      { lateWindow: '61' },
      { maxRuns: '0' },
      { lastSlot: '5' },
      { startAt: '1e3' },
    ]) {
      expect(() =>
        validateConfig({
          ...payment,
          chains: [
            { ...payment.chains[0], snapshot: { ...payment.chains[0].snapshot, plans: [{ ...plan, ...changed }] } },
          ],
        }),
      ).toThrow();
    }
    const validated = validateConfig(payment);
    if (validated.mode === 'local-simulation') throw new Error('unexpected local mode');
    expect(snapshotPlans(validated.chains[0].snapshot!)[0].startAt).toBe(1000n);
  });
  it('standard schema does not echo secret-bearing bad input in diagnostics', () => {
    expect(configSchema['~standard'].validate({ secret: 'sensitive-value' })).toEqual({
      issues: [{ message: 'invalid CRE configuration' }],
    });
  });
});
