// The workflow's decisions against the real contract: its answer must match what the contract actually does. A wrong "due" could
// only waste a report, because the contract checks again, but a wrong "not due" would silently miss a payment.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeEventLog, type Hex } from 'viem';
import {
  EVENTS,
  EXECUTED_TOPIC,
  dueSlot,
  metadataOf,
  onReportCall,
  pickDue,
  plansFrom,
  reportOf,
  simulationPaid,
  type PlanEvent,
  type Simulated,
} from '../../cre/autopay/lib/due.js';
import { EXECUTOR_ABI } from '../../src/autopay/abi.js';
import { autopay, cancelOf, envelope } from '../support/envelopes.js';
import { artifact } from './harness.js';
import { startWorld, type World } from './world.js';

const ALEX: Hex = '0x000000000000000000000000000000000000a11c';

let world: World;
beforeAll(async () => {
  world = await startWorld();
});
afterAll(() => world.stop());
beforeEach(() => world.snapshot());
afterEach(() => world.reset());

/** What the workflow's `filterLogs` sees, from the same one query. */
async function chainEvents(): Promise<PlanEvent[]> {
  const logs = await world.base.pub.getLogs({
    address: world.executorOf(world.base),
    events: EVENTS,
    fromBlock: 0n,
  });
  return logs.map((log: { data: Hex; topics: [Hex, ...Hex[]] }) => {
    const d = decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics });
    if (d.eventName === 'Registered') {
      const { intentId, startAt, interval, lateWindow, maxRuns, redeem } = d.args;
      return { name: 'Registered', id: intentId, startAt, interval, lateWindow, maxRuns, redeem } as PlanEvent;
    }
    if (d.eventName === 'Executed') return { name: 'Executed', id: d.args.intentId, slot: d.args.slot } as PlanEvent;
    return { name: 'Cancelled', id: d.args.intentId } as PlanEvent;
  });
}

const now = async () => BigInt(await world.base.now());
const plans = async () => plansFrom(await chainEvents());
const isDue = async () => {
  const [plan] = await plans();
  return plan ? dueSlot(plan, await now()) !== null : false;
};

async function create(options: { runs?: number; interval?: number; late?: number } = {}) {
  const wallet = await world.startWallet();
  const start = (await world.base.now()) + 3600;
  const k = autopay(0, start, [[ALEX, '10']], options);
  const e = envelope([k]);
  await wallet.post(e);
  await vi.waitFor(() => expect(world.reports.filter((r) => r.kind === 'intent_result')).toHaveLength(1), {
    timeout: 15_000,
  });
  const report = world.reports[0] as Record<string, any>;
  const row = wallet.service.store.autopayByPlan(report.autopay.plan_id);
  return { wallet, start, k, redeem: row?.redeem as Hex, planId: report.autopay.plan_id as Hex };
}

/** eth_simulateV1 as the forwarder, the same call the workflow makes over HTTP. */
async function simulate(redeem: Hex): Promise<Simulated> {
  const forwarder = (await world.base.pub.readContract({
    address: world.executorOf(world.base),
    abi: artifact('IntentExecutorV4.sol', 'IntentExecutorV4').abi,
    functionName: 'getForwarderAddress',
  })) as Hex;
  const metadata = metadataOf({ id: `0x${'00'.repeat(32)}`, name: `0x${'00'.repeat(10)}`, owner: ALEX });
  const result = await world.base.rpc('eth_simulateV1', [
    {
      blockStateCalls: [
        {
          calls: [
            { from: forwarder, to: world.executorOf(world.base), data: onReportCall(metadata, reportOf(redeem)) },
          ],
        },
      ],
      validation: false,
    },
    'latest',
  ]);
  const call = result[0].calls[0];
  return { status: call.status, gasUsed: parseInt(call.gasUsed, 16), logs: call.logs };
}

describe('deciding what is due agrees with the contract', () => {
  it('before the start: not due, and the contract refuses', async () => {
    const { redeem } = await create();
    expect(await isDue()).toBe(false);
    expect((await world.deliver(world.base, redeem)).paid).toBe(false);
  });

  it('inside the window: due, and the contract pays. Then the same slot is no longer due', async () => {
    const { redeem, start } = await create();
    await world.base.setTime(start + 30);
    expect(await isDue()).toBe(true);
    expect((await world.deliver(world.base, redeem)).paid).toBe(true);
    expect(await isDue()).toBe(false);
    expect((await world.deliver(world.base, redeem)).paid).toBe(false);
  });

  it('cron 3 h late with a 1 h window: the slot is skipped, and the next one pays on time', async () => {
    const { redeem, start, k } = await create();
    await world.base.setTime(start + 3 * 3600);
    expect(await isDue()).toBe(false);
    expect((await world.deliver(world.base, redeem)).paid).toBe(false);
    await world.base.setTime(start + k.schedule.interval_seconds + 30);
    expect(await isDue()).toBe(true);
    expect((await world.deliver(world.base, redeem)).paid).toBe(true);
  });

  it('after the last slot: not due, and the contract refuses', async () => {
    const { redeem, start, k } = await create({ runs: 1 });
    await world.base.setTime(start + k.schedule.interval_seconds + 30);
    expect(await isDue()).toBe(false);
    expect((await world.deliver(world.base, redeem)).paid).toBe(false);
  });

  it('cancelled: gone from the list, and the contract refuses', async () => {
    const { wallet, redeem, start, planId } = await create();
    const e = envelope([cancelOf(0, 'ap_000000abc000', planId)]);
    await wallet.post(e);
    await vi.waitFor(() => expect(world.reports.some((r) => r.request_id === e.request_id)).toBe(true), {
      timeout: 15_000,
    });
    expect(await plans()).toEqual([]);
    await world.base.setTime(start + 30);
    expect((await world.deliver(world.base, redeem)).paid).toBe(false);
  });
});

describe('the simulation', () => {
  it('recognises a USDC run as paying. The old workflow would have skipped this one (Part 9)', async () => {
    const { redeem, start } = await create();
    await world.base.setTime(start + 30);
    expect(simulationPaid(await simulate(redeem), world.executorOf(world.base))).toBe(true);
  });

  it('shows no payment when the run is not due', async () => {
    const { redeem } = await create();
    expect(simulationPaid(await simulate(redeem), world.executorOf(world.base))).toBe(false);
  });

  it('a failed simulation is not a payment, even if it shows the event', () => {
    const executor = world.executorOf(world.base);
    const logs = [{ address: executor, topics: [EXECUTED_TOPIC] }];
    expect(simulationPaid({ status: '0x1', gasUsed: 1, logs }, executor)).toBe(true);
    expect(simulationPaid({ status: '0x0', gasUsed: 1, logs }, executor)).toBe(false);
  });

  it('uses the topic the contract really emits', async () => {
    expect(EXECUTED_TOPIC).toBe('0x5bdbb4c0043be30b3add653520cbb8c1590daf78c8f3ae8cad58e3cc9c1b0fd2');
    expect(EXECUTOR_ABI.some((x) => x.type === 'event' && x.name === 'Executed')).toBe(true);
  });
});

describe('more due than fit in one execution (A.5 rule 10)', () => {
  const plan = (n: number, closes: bigint) => ({
    id: `0x${n.toString(16).padStart(64, '0')}` as Hex,
    startAt: closes - 3600n,
    interval: 86400n,
    lateWindow: 3600n,
    maxRuns: 3n,
    redeem: '0x' as Hex,
    lastSlot: -1n,
    cancelled: false,
  });

  it('takes the runs that close soonest, across chains, up to the cap. The rest stay due next time', () => {
    const now = 1_000_000n;
    const a = Array.from({ length: 10 }, (_, n) => plan(n, now + 100n + BigInt(n) * 10n));
    const b = Array.from({ length: 10 }, (_, n) => plan(n + 100, now + 105n + BigInt(n) * 10n));
    const picked = pickDue(
      [
        { chain: 'a', plans: a },
        { chain: 'b', plans: b },
      ],
      now,
      14,
    );
    expect(picked).toHaveLength(14);
    expect(picked.map((p) => p.closesAt)).toEqual([...picked.map((p) => p.closesAt)].sort((x, y) => (x < y ? -1 : 1)));
    expect(picked[0]?.chain).toBe('a');
    expect(picked[1]?.chain).toBe('b');
    expect(dueSlot(a[9] as (typeof a)[0], now)).toBe(0n);
  });
});
