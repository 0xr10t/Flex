// Autopay and cancel, from an HTTP request through to payments and reports. `deliver` plays CRE's cron.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, keccak256, parseEventLogs, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { autoApprove } from '../../src/approval.js';
import { DELEGATION_MANAGER_ABI, EXECUTOR_ABI } from '../../src/autopay/abi.js';
import { createChainGateway, type SimBlock } from '../../src/chain/gateway.js';
import { silentLogger } from '../../src/log.js';
import { reportCall } from '../../src/autopay/report-call.js';
import { encodeExecuteBatch } from '../../src/payments/payment-i.js';
import { Runner } from '../../src/runner/runner.js';
import { openDatabase, Store } from '../../src/store/store.js';
import { BASE, DB_KEY, WALLET, autopay, cancelOf, envelope, payUsdc } from '../support/envelopes.js';
import { userAccount } from './harness.js';
import { startWorld, units, type World } from './world.js';
import { join } from 'node:path';

const ALEX: Hex = '0x000000000000000000000000000000000000a11c';
const BOB: Hex = '0x0000000000000000000000000000000000000b0b';
const FEE_TO: Hex = '0x000000000000000000000000000000000000fee0';
const address = (n: number) => `0x${(0x100000 + n).toString(16).padStart(40, '0')}` as Hex;
// Public Anvil test key: another user on the same shared executor.
const STRANGER = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1fb6367f6bf8e3d5d6d9e5a6e2f4f3a8a4e2b' as Hex);

let world: World;
beforeAll(async () => {
  world = await startWorld();
});
afterAll(() => world.stop());
beforeEach(() => world.snapshot());
afterEach(() => world.reset());

const reportsFor = (id: string) => world.reports.filter((r) => r.request_id === id);
const runReports = () => world.reports.filter((r) => r.kind === 'autopay_payment');

const waitForReports = (id: string, count: number) =>
  vi.waitFor(() => expect(reportsFor(id).length).toBeGreaterThanOrEqual(count), { timeout: 20_000, interval: 40 });

/** Registers an autopay through the wallet and returns what later steps need. */
async function createAutopay(
  wallet: Awaited<ReturnType<World['startWallet']>>,
  recipients: [Hex, string][],
  options = {},
) {
  const start = (await world.base.now()) + 3600;
  const k = autopay(0, start, recipients, options);
  const e = envelope([k]);
  expect((await wallet.post(e)).status).toBe(202);
  await waitForReports(e.request_id, 1);
  const report = reportsFor(e.request_id)[0] as Record<string, any>;
  expect(report).toMatchObject({ kind: 'intent_result', status: 'executed' });
  const row = wallet.service.store.autopayByPlan(report.autopay.plan_id) as NonNullable<
    ReturnType<Store['autopayByPlan']>
  >;
  return { k, e, report, row, start, interval: k.schedule.interval_seconds, planId: report.autopay.plan_id as Hex };
}

describe('creating an autopay (k)', () => {
  it('registers a plan, moves no money, and reports the plan id and executor', async () => {
    const wallet = await world.startWallet();
    const before = await world.base.usdcOf(WALLET);
    const { report, row, planId } = await createAutopay(wallet, [[ALEX, '10']]);

    expect(report.autopay).toEqual({
      autopay_id: 'ap_000000abc000',
      plan_id: planId,
      executor_address: world.executorOf(world.base),
    });
    expect(planId).toBe(keccak256(row.redeem));
    expect(row.status).toBe('active');
    expect(await world.base.usdcOf(WALLET)).toBe(before);
    expect(await world.base.usdcOf(ALEX)).toBe(0n);
    const logs = await world.base.pub.getContractEvents({
      address: world.executorOf(world.base),
      abi: EXECUTOR_ABI,
      eventName: 'Registered',
    });
    expect(logs).toHaveLength(1);
  });

  it('two legs make two plans (A-64)', async () => {
    const wallet = await world.startWallet();
    const start = (await world.base.now()) + 3600;
    const e = envelope([
      autopay(0, start, [[ALEX, '10']], { autopayId: 'ap_00000000000a', runs: 4, interval: 604800 }),
      autopay(1, start + 3 * 86400, [[ALEX, '10']], { autopayId: 'ap_00000000000b', runs: 4, interval: 604800 }),
    ]);
    await wallet.post(e);
    await waitForReports(e.request_id, 2);
    const plans = reportsFor(e.request_id).map((r) => r.autopay.plan_id);
    expect(new Set(plans).size).toBe(2);
    expect(reportsFor(e.request_id).map((r) => r.status)).toEqual(['executed', 'executed']);
  });

  it('the same request sent twice makes one plan', async () => {
    const wallet = await world.startWallet();
    const { e } = await createAutopay(wallet, [[ALEX, '10']]);
    expect((await wallet.post(e)).status).toBe(202);
    await new Promise((r) => setTimeout(r, 200));
    const logs = await world.base.pub.getContractEvents({
      address: world.executorOf(world.base),
      abi: EXECUTOR_ABI,
      eventName: 'Registered',
    });
    expect(logs).toHaveLength(1);
    expect(reportsFor(e.request_id)).toHaveLength(1);
  });

  it('fails, and registers nothing, if the start time passed before it could register (OQ-11)', async () => {
    const wallet = await world.startWallet({ approval: 'auto_approve_testnets' });
    const start = (await world.base.now()) + 3600;
    await world.base.setTime(start + 10);
    const e = envelope([autopay(0, start, [[ALEX, '10']])]);
    await wallet.post(e);
    await waitForReports(e.request_id, 1);
    expect(reportsFor(e.request_id)[0]).toMatchObject({ status: 'failed', autopay: { autopay_id: 'ap_000000abc000' } });
    expect(wallet.service.store.stepsOf(e.request_id)[0]?.error_code).toBe('START_PASSED');
  });

  it('a refused approval signs nothing, and tells the agent which autopay failed', async () => {
    const wallet = await world.startWallet({ approval: 'reject_all' });
    const e = envelope([autopay(0, (await world.base.now()) + 3600, [[ALEX, '10']])]);
    await wallet.post(e);
    await waitForReports(e.request_id, 1);
    expect(reportsFor(e.request_id)[0]).toMatchObject({ status: 'failed', autopay: { autopay_id: 'ap_000000abc000' } });
    expect(wallet.service.store.autopayByStep(e.request_id, 0)).toBeNull();
  });

  it('runs with one-time payments in one request', async () => {
    const wallet = await world.startWallet();
    const e = envelope([payUsdc(0, [[BOB, '5']]), autopay(1, (await world.base.now()) + 3600, [[ALEX, '10']])]);
    await wallet.post(e);
    await waitForReports(e.request_id, 2);
    expect(reportsFor(e.request_id).map((r) => r.status)).toEqual(['executed', 'executed']);
    expect(await world.base.usdcOf(BOB)).toBe(units('5'));
  });
});

describe('crashes while creating an autopay', () => {
  const setUp = async () => {
    const path = join(world.dir, 'crash.db');
    const db = openDatabase(path, DB_KEY);
    const store = new Store(db);
    const real = createChainGateway(BASE, world.base.rpcUrl, userAccount);
    const deployment = { executor: world.executorOf(world.base), deploymentBlock: 0, env: world.base.env };
    const runner = (gateway: typeof real) =>
      new Runner({
        store,
        walletAddress: WALLET,
        approver: autoApprove,
        gatewayFor: () => gateway,
        deploymentFor: () => deployment,
        log: silentLogger,
        onReportQueued: () => {},
        pollMs: 20,
      });
    return { db, store, real, runner };
  };
  const hang = () => new Promise<never>(() => {});
  const registered = async () =>
    world.base.pub.getContractEvents({
      address: world.executorOf(world.base),
      abi: EXECUTOR_ABI,
      eventName: 'Registered',
    });

  it('after signing, before register: the restart sends the same signature, making one plan', async () => {
    const { db, store, real, runner } = await setUp();
    const e = envelope([autopay(0, (await world.base.now()) + 3600, [[ALEX, '10']])]);
    store.insertRequest(e, '2026-11-06T10:00:00.000Z');
    void runner({ ...real, prepareAndSign: hang }).kick();
    await vi.waitFor(() => expect(store.autopayByStep(e.request_id, 0)).not.toBeNull(), { timeout: 10_000 });
    const before = store.autopayByStep(e.request_id, 0);
    expect(await registered()).toHaveLength(0);

    await runner(real).kick();
    expect(store.stepsOf(e.request_id)[0]?.status).toBe('executed');
    expect(store.autopayByStep(e.request_id, 0)?.plan_id).toBe(before?.plan_id);
    expect(await registered()).toHaveLength(1);
    db.close();
  });

  it('after signing, with the start time passing before the restart: fails, and registers nothing (OQ-11)', async () => {
    const { db, store, real, runner } = await setUp();
    const start = (await world.base.now()) + 3600;
    const e = envelope([autopay(0, start, [[ALEX, '10']])]);
    store.insertRequest(e, '2026-11-06T10:00:00.000Z');
    void runner({ ...real, prepareAndSign: hang }).kick();
    await vi.waitFor(() => expect(store.autopayByStep(e.request_id, 0)).not.toBeNull(), { timeout: 10_000 });
    await world.base.setTime(start + 10);

    await runner(real).kick();
    expect(store.stepsOf(e.request_id)[0]?.error_code).toBe('START_PASSED');
    expect(await registered()).toHaveLength(0);
    db.close();
  });

  it('after register, before its result is stored: the restart finds it, making one plan', async () => {
    const { db, store, real, runner } = await setUp();
    const e = envelope([autopay(0, (await world.base.now()) + 3600, [[ALEX, '10']])]);
    store.insertRequest(e, '2026-11-06T10:00:00.000Z');
    let first = true;
    const dies = {
      ...real,
      getReceipt: async (hash: Hex) => {
        if (first) {
          first = false;
          return real.getReceipt(hash);
        }
        return hang();
      },
    };
    void runner(dies).kick();
    await vi.waitFor(async () => expect(await registered()).toHaveLength(1), { timeout: 10_000 });
    expect(store.stepsOf(e.request_id)[0]?.status).toBe('signed');

    await runner(real).kick();
    expect(store.stepsOf(e.request_id)[0]?.status).toBe('executed');
    expect(await registered()).toHaveLength(1);
    db.close();
  });

  it('the plan is already on chain while the wallet has only its draft: reports it, and sends nothing', async () => {
    const { db, store, real, runner } = await setUp();
    const e = envelope([autopay(0, (await world.base.now()) + 3600, [[ALEX, '10']])]);
    store.insertRequest(e, '2026-11-06T10:00:00.000Z');
    void runner({ ...real, prepareAndSign: hang }).kick();
    await vi.waitFor(() => expect(store.autopayByStep(e.request_id, 0)).not.toBeNull(), { timeout: 10_000 });
    const row = store.autopayByStep(e.request_id, 0) as NonNullable<ReturnType<Store['autopayByStep']>>;
    const k = e.intents[0] as ReturnType<typeof autopay>;
    const hash = await world.base.walletFor(userAccount).sendTransaction({
      to: row.executor,
      data: encodeFunctionData({
        abi: EXECUTOR_ABI,
        functionName: 'register',
        args: [
          BigInt(k.schedule.start_at),
          BigInt(k.schedule.interval_seconds),
          BigInt(k.schedule.late_window_seconds),
          BigInt(k.schedule.max_runs),
          row.redeem,
        ],
      }),
    });
    await world.base.pub.waitForTransactionReceipt({ hash });
    const nonce = await world.base.pub.getTransactionCount({ address: WALLET });

    await runner(real).kick();
    const [step] = store.stepsOf(e.request_id);
    expect(step?.status).toBe('executed');
    expect(step?.tx_hash).toBe(hash);
    expect(store.autopayByStep(e.request_id, 0)?.status).toBe('active');
    expect(await world.base.pub.getTransactionCount({ address: WALLET })).toBe(nonce);
    db.close();
  });
});

describe('the check before signing an autopay', () => {
  it('not enough money for the first run: stops before the permission is signed', async () => {
    const wallet = await world.startWallet();
    const e = envelope([autopay(0, (await world.base.now()) + 3600, [[ALEX, '200000']])]);
    await wallet.post(e);
    await waitForReports(e.request_id, 1);
    expect(reportsFor(e.request_id)[0]).toMatchObject({ status: 'failed', autopay: { autopay_id: 'ap_000000abc000' } });
    expect(wallet.service.store.stepsOf(e.request_id)[0]?.error_code).toBe('SIMULATION_FAILED');
    expect(wallet.service.store.autopayByStep(e.request_id, 0)).toBeNull();
  });

  it('after signing, it simulates register and the first run. If that fails, register is never sent', async () => {
    const db = openDatabase(join(world.dir, 'second-check.db'), DB_KEY);
    const store = new Store(db);
    const real = createChainGateway(BASE, world.base.rpcUrl, userAccount);
    let simulations = 0;
    const seen: SimBlock[][] = [];
    const secondFails = {
      ...real,
      simulate: async (blocks: SimBlock[]) => {
        simulations++;
        seen.push(blocks);
        const results = await real.simulate(blocks);
        return simulations === 1
          ? results
          : results.map((b) => b.map(() => ({ status: 'failure' as const, logs: [] })));
      },
    };
    const start = (await world.base.now()) + 3600;
    const e = envelope([autopay(0, start, [[ALEX, '10']])]);
    store.insertRequest(e, '2026-11-06T10:00:00.000Z');
    await new Runner({
      store,
      walletAddress: WALLET,
      approver: autoApprove,
      gatewayFor: () => secondFails,
      deploymentFor: () => ({ executor: world.executorOf(world.base), deploymentBlock: 0, env: world.base.env }),
      log: silentLogger,
      onReportQueued: () => {},
      pollMs: 20,
    }).kick();

    expect(store.stepsOf(e.request_id)[0]?.error_code).toBe('SIMULATION_FAILED');
    expect(simulations).toBe(2);
    expect(seen[1]).toHaveLength(2);
    expect(seen[1]?.[1]?.time).toBe(start);
    const logs = await world.base.pub.getContractEvents({
      address: world.executorOf(world.base),
      abi: EXECUTOR_ABI,
      eventName: 'Registered',
    });
    expect(logs).toHaveLength(0);
    db.close();
  });
});

describe('each run (CRE plays its part here; the rules are the contract’s)', () => {
  it('pays on time, can’t pay twice for one slot, and each paid run reaches the agent', async () => {
    const wallet = await world.startWallet();
    const { row, start, interval, planId, e } = await createAutopay(wallet, [
      [ALEX, '10'],
      [BOB, '5'],
    ]);

    expect((await world.deliver(world.base, row.redeem)).paid).toBe(false);

    await world.base.setTime(start + 30);
    expect((await world.deliver(world.base, row.redeem)).paid).toBe(true);
    expect((await world.deliver(world.base, row.redeem)).paid).toBe(false);
    expect(await world.base.usdcOf(ALEX)).toBe(units('10'));
    expect(await world.base.usdcOf(BOB)).toBe(units('5'));
    expect(await world.base.usdcOf(FEE_TO)).toBe(units('0.05'));

    await vi.waitFor(() => expect(runReports()).toHaveLength(1), { timeout: 10_000, interval: 40 });
    expect(runReports()[0]).toMatchObject({
      kind: 'autopay_payment',
      request_id: e.request_id,
      status: 'executed',
      autopay: {
        autopay_id: 'ap_000000abc000',
        plan_id: planId,
        executor_address: world.executorOf(world.base),
        slot: 0,
        status: 'active',
        amount: '15',
        fee: '0.05',
        chain_id: BASE,
        token: 'USDC',
      },
    });
    expect(runReports()[0]?.tx_hash).toMatch(/^0x/);

    await world.base.setTime(start + interval + 30);
    expect((await world.deliver(world.base, row.redeem)).paid).toBe(true);
    await vi.waitFor(() => expect(runReports().map((r) => r.autopay.slot)).toEqual([0, 1]), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(runReports()).toHaveLength(2);
  });

  it('a run with a 50-person list goes through the wallet too', async () => {
    const wallet = await world.startWallet();
    const people = Array.from({ length: 50 }, (_, n): [Hex, string] => [address(n), String(n + 1)]);
    const { row, start } = await createAutopay(wallet, people);
    await world.base.setTime(start + 30);
    expect((await world.deliver(world.base, row.redeem)).paid).toBe(true);
    expect(await world.base.usdcOf(address(49))).toBe(units('50'));
    await vi.waitFor(() => expect(runReports()[0]?.autopay.amount).toBe('1275'), { timeout: 10_000 });
  });

  it('runs while the wallet is off are reported after it restarts, in order, once each', async () => {
    let wallet = await world.startWallet({ dbName: 'kept.db' });
    const { row, start, interval } = await createAutopay(wallet, [[ALEX, '10']]);
    await wallet.stop();

    await world.base.setTime(start + 30);
    expect((await world.deliver(world.base, row.redeem)).paid).toBe(true);
    await world.base.setTime(start + interval + 30);
    expect((await world.deliver(world.base, row.redeem)).paid).toBe(true);
    expect(runReports()).toHaveLength(0);

    wallet = await world.startWallet({ dbName: 'kept.db' });
    await vi.waitFor(() => expect(runReports().map((r) => r.autopay.slot)).toEqual([0, 1]), { timeout: 10_000 });
    await wallet.stop();

    wallet = await world.startWallet({ dbName: 'kept.db' });
    await new Promise((r) => setTimeout(r, 300));
    expect(runReports()).toHaveLength(2);
  });

  it('a rescan of the chain reports nothing twice', async () => {
    const wallet = await world.startWallet();
    const { row, start } = await createAutopay(wallet, [[ALEX, '10']]);
    await world.base.setTime(start + 30);
    await world.deliver(world.base, row.redeem);
    await vi.waitFor(() => expect(runReports()).toHaveLength(1), { timeout: 10_000 });
    wallet.service.store.setWatchCursor(BASE, 0);
    await vi.waitFor(() => expect(wallet.service.store.watchCursor(BASE)).toBeGreaterThan(0), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(runReports()).toHaveLength(1);
  });

  it('the agent being down loses nothing: the report arrives once it is back', async () => {
    const wallet = await world.startWallet();
    const { row, start } = await createAutopay(wallet, [[ALEX, '10']]);
    world.agentStatus.code = 503;
    await world.base.setTime(start + 30);
    await world.deliver(world.base, row.redeem);
    await new Promise((r) => setTimeout(r, 300));
    expect(runReports()).toHaveLength(0);
    world.agentStatus.code = 204;
    await vi.waitFor(() => expect(runReports()).toHaveLength(1), { timeout: 15_000, interval: 100 });
  });

  it('a forwarder transaction with no Executed event reports nothing (A.5 rule 5)', async () => {
    const wallet = await world.startWallet();
    const { row } = await createAutopay(wallet, [[ALEX, '10']]);
    expect((await world.deliver(world.base, row.redeem)).paid).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(runReports()).toHaveLength(0);
  });

  it('ignores runs of another user on the shared executor', async () => {
    const wallet = await world.startWallet();
    await createAutopay(wallet, [[ALEX, '10']]);
    const hash = await world.base.deployer.sendTransaction({ to: STRANGER.address, value: 10n ** 18n });
    await world.base.pub.waitForTransactionReceipt({ hash });
    await world.upgrade(world.base, STRANGER);
    await new Promise((r) => setTimeout(r, 200));
    expect(runReports()).toHaveLength(0);
  });

  it('reports `ended` once, after the plan’s end has passed, with its last run first', async () => {
    const wallet = await world.startWallet();
    const { row, start, k, e } = await createAutopay(wallet, [[ALEX, '10']], { runs: 1 });
    await world.base.setTime(start + 30);
    await world.deliver(world.base, row.redeem);
    await world.base.setTime(k.schedule.end_at + 10);
    await vi.waitFor(
      () =>
        expect(reportsFor(e.request_id).map((r) => r.kind)).toEqual([
          'intent_result',
          'autopay_payment',
          'autopay_status',
        ]),
      { timeout: 10_000 },
    );
    expect(reportsFor(e.request_id)[2]?.autopay).toMatchObject({ status: 'ended', autopay_id: 'ap_000000abc000' });
    await new Promise((r) => setTimeout(r, 200));
    expect(reportsFor(e.request_id)).toHaveLength(3);
  });
});

describe('cancelling (l)', () => {
  const cancel = async (wallet: Awaited<ReturnType<World['startWallet']>>, autopayId: string, planId: Hex) => {
    const e = envelope([cancelOf(0, autopayId, planId)]);
    expect((await wallet.post(e)).status).toBe(202);
    await waitForReports(e.request_id, 1);
    return { e, report: reportsFor(e.request_id)[0] as Record<string, any> };
  };

  it('stops the plan and kills the permission. Earlier runs stay paid, later ones pay nothing (A.3)', async () => {
    const wallet = await world.startWallet();
    const { row, start, interval, planId } = await createAutopay(wallet, [[ALEX, '10']]);
    await world.base.setTime(start + 30);
    expect((await world.deliver(world.base, row.redeem)).paid).toBe(true);

    const walletBalance = await world.base.usdcOf(WALLET);
    const { report } = await cancel(wallet, 'ap_000000abc000', planId);
    expect(report).toMatchObject({ status: 'executed', autopay: { autopay_id: 'ap_000000abc000' } });
    const receipt = await world.base.pub.getTransactionReceipt({ hash: report.tx_hash });
    expect(parseEventLogs({ abi: EXECUTOR_ABI, logs: receipt.logs, eventName: 'Cancelled' })).toHaveLength(1);
    expect(
      parseEventLogs({ abi: DELEGATION_MANAGER_ABI, logs: receipt.logs, eventName: 'DisabledDelegation' }),
    ).toHaveLength(1);
    expect(wallet.service.store.autopayByPlan(planId)?.status).toBe('cancelled');

    await world.base.setTime(start + interval + 30);
    expect((await world.deliver(world.base, row.redeem)).paid).toBe(false);
    expect(await world.base.usdcOf(ALEX)).toBe(units('10'));
    expect(await world.base.usdcOf(WALLET)).toBe(walletBalance);

    // Even the executor redeeming directly is refused, because the delegation itself is disabled.
    await expect(
      world.base.pub.call({
        account: world.executorOf(world.base),
        to: world.base.env.DelegationManager,
        data: row.redeem,
      }),
    ).rejects.toThrow();
  });

  it('works from the chain alone, if the wallet’s store was lost (§12.5)', async () => {
    const first = await world.startWallet();
    const { planId, row, start } = await createAutopay(first, [[ALEX, '10']]);
    await first.stop();

    const fresh = await world.startWallet();
    const { report } = await cancel(fresh, 'ap_000000abc000', planId);
    expect(report).toMatchObject({ status: 'executed' });
    await world.base.setTime(start + 30);
    expect((await world.deliver(world.base, row.redeem)).paid).toBe(false);
  });

  it('the check simulates a later run, and it shows that run paying nothing', async () => {
    const wallet = await world.startWallet();
    const { planId, row, start } = await createAutopay(wallet, [[ALEX, '10']]);
    const real = createChainGateway(BASE, world.base.rpcUrl, userAccount);
    const calls = encodeFunctionData({
      abi: EXECUTOR_ABI,
      functionName: 'cancel',
      args: [planId],
    });
    const batch = encodeExecuteBatch([{ target: row.executor, value: 0n, callData: calls }]);
    const report = await reportCall(real, row.executor, row.redeem);
    const without = await real.simulate([{ calls: [report], time: start }]);
    expect(without[0]?.[0]?.status).toBe('success');
    const results = await real.simulate([
      { calls: [{ from: WALLET, to: WALLET, data: batch }] },
      { calls: [report], time: start },
    ]);
    expect(results[0]?.[0]?.status).toBe('success');
    expect(results[1]?.[0]?.status).toBe('failure');
  });

  it('an unknown plan id fails, and nothing is signed', async () => {
    const wallet = await world.startWallet();
    await wallet.post(envelope([payUsdc(0, [[BOB, '1']])]));
    await vi.waitFor(() => expect(world.reports).toHaveLength(1), { timeout: 10_000 });
    const nonce = await world.base.pub.getTransactionCount({ address: WALLET });
    const { report, e } = await cancel(wallet, 'ap_000000abc000', `0x${'ab'.repeat(32)}`);
    expect(report).toMatchObject({ status: 'failed', autopay: { autopay_id: 'ap_000000abc000' } });
    expect(wallet.service.store.stepsOf(e.request_id)[0]?.error_code).toBe('UNKNOWN_PLAN');
    expect(await world.base.pub.getTransactionCount({ address: WALLET })).toBe(nonce);
  });

  it('a cancel of a plan already cancelled succeeds, and sends nothing', async () => {
    const wallet = await world.startWallet();
    const { planId } = await createAutopay(wallet, [[ALEX, '10']]);
    await cancel(wallet, 'ap_000000abc000', planId);
    const nonce = await world.base.pub.getTransactionCount({ address: WALLET });
    const { report } = await cancel(wallet, 'ap_000000abc000', planId);
    expect(report).toMatchObject({ status: 'executed' });
    expect(await world.base.pub.getTransactionCount({ address: WALLET })).toBe(nonce);
  });

  it('a plan that has already finished can still be cancelled safely', async () => {
    const wallet = await world.startWallet();
    const { planId, k } = await createAutopay(wallet, [[ALEX, '10']], { runs: 1 });
    await world.base.setTime(k.schedule.end_at + 10);
    const { report } = await cancel(wallet, 'ap_000000abc000', planId);
    expect(report).toMatchObject({ status: 'executed' });
  });

  it('a run paid just before the cancel is still reported', async () => {
    let wallet = await world.startWallet({ dbName: 'kept.db' });
    const { row, start, planId } = await createAutopay(wallet, [[ALEX, '10']]);
    await wallet.stop();
    await world.base.setTime(start + 30);
    expect((await world.deliver(world.base, row.redeem)).paid).toBe(true);
    wallet = await world.startWallet({ dbName: 'kept.db' });
    await cancel(wallet, 'ap_000000abc000', planId);
    await vi.waitFor(() => expect(runReports()).toHaveLength(1), { timeout: 10_000 });
  });
});
