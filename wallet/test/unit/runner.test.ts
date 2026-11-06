import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { rejectAll, autoApprove, type Approver } from '../../src/approval.js';
import { silentLogger, type Logger } from '../../src/log.js';
import { Runner } from '../../src/runner/runner.js';
import type { HandoffEnvelope } from '@flex/protocol/schemas/envelope';
import { USDC } from '@flex/protocol/schemas/intent.v2';
import { ALEX, BOB, WALLET, BASE, envelope, payUsdc, payEth } from '../support/envelopes.js';
import { FakeChain, transferLog } from '../support/fake-chain.js';
import { Store } from '../../src/store/store.js';
import { tempDb } from '../support/temp-db.js';

const newStore = () => new Store(tempDb());

const runnerOn = (
  store: Store,
  chain: FakeChain,
  over: { approver?: Approver; log?: Logger; maxTries?: number } = {},
) =>
  new Runner({
    store,
    walletAddress: WALLET,
    approver: over.approver ?? autoApprove,
    gatewayFor: () => chain,
    log: over.log ?? silentLogger,
    onReportQueued: () => {},
    pollMs: 1,
    ...(over.maxTries === undefined ? {} : { maxTries: over.maxTries }),
  });

const submit = (store: Store, e: HandoffEnvelope): HandoffEnvelope => {
  store.insertRequest(e, '2026-11-06T10:00:00.000Z');
  return e;
};
const statuses = (store: Store, e: HandoffEnvelope) => store.stepsOf(e.request_id).map((s) => s.status);
const codes = (store: Store, e: HandoffEnvelope) => store.stepsOf(e.request_id).map((s) => s.error_code);

/** A chain that really pays: each sent transaction logs the transfers `e` asks for. */
const payingFor = (chain: FakeChain, e: HandoffEnvelope, step = 0) => {
  const intent = e.intents.find((x) => x.step === step);
  if (intent?.intent_id !== 'i') throw new Error('not a payment');
  chain.receiptFor = () => ({
    status: 'success',
    executedAt: '2026-11-06T10:00:05.000Z',
    blockNumber: 1,
    logs: intent.recipients.map((r) => transferLog(USDC[BASE], WALLET, r.recipient, BigInt(r.amount.base_units))),
  });
};

describe('order and dependencies (rule 2, OQ-08)', () => {
  it('runs steps in order', async () => {
    const store = newStore();
    const chain = new FakeChain();
    const e = submit(store, envelope([payEth(0, [[ALEX, '0.01']]), payEth(1, [[BOB, '0.02']])]));
    await runnerOn(store, chain).kick();
    expect(statuses(store, e)).toEqual(['executed', 'executed']);
    expect(chain.log).toEqual(['sign', 'send', 'sign', 'send']);
  });

  it('never starts a step whose dependency failed, and still runs an independent step', async () => {
    const store = newStore();
    const chain = new FakeChain();
    const e = submit(
      store,
      envelope([
        payEth(0, [[ALEX, '0.01']]),
        { ...payUsdc(1, [[BOB, '1']]), depends_on: [0] },
        payEth(2, [[BOB, '0.02']]),
      ]),
    );
    let calls = 0;
    const firstRefused: Approver = { approve: async () => ++calls > 1 };
    await runnerOn(store, chain, { approver: firstRefused }).kick();
    expect(statuses(store, e)).toEqual(['failed', 'failed', 'executed']);
    expect(codes(store, e)).toEqual(['USER_REJECTED', 'DEPENDENCY_FAILED', null]);
    expect(chain.signed).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('finishes one request before starting the next', async () => {
    const store = newStore();
    const chain = new FakeChain();
    const first = submit(store, envelope([payEth(0, [[ALEX, '0.01']])]));
    const second = submit(store, envelope([payEth(0, [[BOB, '0.02']])]));
    await runnerOn(store, chain).kick();
    expect(statuses(store, first)).toEqual(['executed']);
    expect(statuses(store, second)).toEqual(['executed']);
    expect(store.allReports().map((r) => r.request_id)).toEqual([first.request_id, second.request_id]);
  });
});

describe('approval (OQ-01, OQ-02)', () => {
  it('signs nothing when approval is refused, and reports a failure', async () => {
    const store = newStore();
    const chain = new FakeChain();
    const e = submit(store, envelope([payEth(0, [[ALEX, '0.01']])]));
    await runnerOn(store, chain, { approver: rejectAll }).kick();
    expect(chain.signed).toHaveLength(0);
    expect(codes(store, e)).toEqual(['USER_REJECTED']);
    expect(JSON.parse(store.allReports()[0]!.body_json)).toEqual({
      kind: 'intent_result',
      request_id: e.request_id,
      step: 0,
      status: 'failed',
    });
  });

  it('asks before upgrading the account', async () => {
    const store = newStore();
    const chain = new FakeChain();
    chain.code = undefined;
    submit(store, envelope([payEth(0, [[ALEX, '0.01']])]));
    await runnerOn(store, chain, { approver: rejectAll }).kick();
    expect(chain.upgrades).toBe(0);
  });
});

describe('the account (A.1, OQ-19)', () => {
  it('upgrades a plain account once, on first use', async () => {
    const store = newStore();
    const chain = new FakeChain();
    chain.code = undefined;
    const e = submit(store, envelope([payEth(0, [[ALEX, '0.01']]), payEth(1, [[BOB, '0.02']])]));
    await runnerOn(store, chain).kick();
    expect(chain.upgrades).toBe(1);
    expect(statuses(store, e)).toEqual(['executed', 'executed']);
  });

  it.each([
    ['delegated to other code', `0xef0100${'12'.repeat(20)}` as Hex],
    ['a contract', '0x6001' as Hex],
  ])('refuses an account that is %s, and signs nothing', async (_name, code) => {
    const store = newStore();
    const chain = new FakeChain();
    chain.code = code;
    const e = submit(store, envelope([payEth(0, [[ALEX, '0.01']])]));
    await runnerOn(store, chain).kick();
    expect(codes(store, e)).toEqual(['ACCOUNT_DELEGATED_ELSEWHERE']);
    expect(chain.signed).toHaveLength(0);
    expect(chain.upgrades).toBe(0);
    expect(chain.code).toBe(code);
  });

  it('does not treat the upgrade as done unless the code changed', async () => {
    const store = newStore();
    const chain = new FakeChain();
    chain.code = undefined;
    chain.sendUpgrade = async () => {};
    const e = submit(store, envelope([payEth(0, [[ALEX, '0.01']])]));
    await runnerOn(store, chain).kick();
    expect(codes(store, e)).toEqual(['UPGRADE_FAILED']);
    expect(chain.signed).toHaveLength(0);
  });
});

describe('success means the effect (rule 8)', () => {
  it('reports executed with the hash and time when the transfers happened', async () => {
    const store = newStore();
    const chain = new FakeChain();
    const e = submit(
      store,
      envelope([
        payUsdc(0, [
          [ALEX, '10'],
          [BOB, '20'],
        ]),
      ]),
    );
    payingFor(chain, e);
    await runnerOn(store, chain).kick();
    const [step] = store.stepsOf(e.request_id);
    expect(step?.status).toBe('executed');
    expect(JSON.parse(store.allReports()[0]!.body_json)).toEqual({
      kind: 'intent_result',
      request_id: e.request_id,
      step: 0,
      status: 'executed',
      tx_hash: step?.tx_hash,
      executed_at: '2026-11-06T10:00:05.000Z',
    });
  });

  it('reports failed when the receipt succeeded but no USDC moved (B1)', async () => {
    const store = newStore();
    const chain = new FakeChain();
    const e = submit(store, envelope([payUsdc(0, [[ALEX, '10']])]));
    await runnerOn(store, chain).kick();
    expect(codes(store, e)).toEqual(['EFFECT_MISSING']);
    expect(statuses(store, e)).toEqual(['failed']);
  });

  it('reports failed when the transaction reverted, keeping its hash', async () => {
    const store = newStore();
    const chain = new FakeChain();
    chain.receiptFor = () => ({ status: 'reverted', logs: [], executedAt: '2026-11-06T10:00:05.000Z', blockNumber: 1 });
    const e = submit(store, envelope([payEth(0, [[ALEX, '0.01']])]));
    await runnerOn(store, chain).kick();
    expect(codes(store, e)).toEqual(['TX_REVERTED']);
    expect(JSON.parse(store.allReports()[0]!.body_json).tx_hash).toBe(store.stepsOf(e.request_id)[0]?.tx_hash);
  });

  it('sends nothing when the chain says the transaction would fail', async () => {
    const store = newStore();
    const chain = new FakeChain();
    chain.wouldFail = true;
    const e = submit(store, envelope([payEth(0, [[ALEX, '0.01']])]));
    await runnerOn(store, chain).kick();
    expect(codes(store, e)).toEqual(['WOULD_FAIL']);
    expect(chain.broadcasts).toHaveLength(0);
  });

  it('reports failed when another transaction took the nonce, since this one can never be mined', async () => {
    const store = newStore();
    const chain = new FakeChain();
    chain.receiptFor = () => null;
    chain.mined = 1;
    const e = submit(store, envelope([payEth(0, [[ALEX, '0.01']])]));
    await runnerOn(store, chain).kick();
    expect(codes(store, e)).toEqual(['TX_REPLACED']);
  });
});

describe('an unreachable chain', () => {
  it('gives up after some tries when nothing has been signed, because nothing can have moved', async () => {
    const store = newStore();
    const chain = new FakeChain();
    chain.unavailable.prepareAndSign = true;
    const e = submit(store, envelope([payEth(0, [[ALEX, '0.01']])]));
    await runnerOn(store, chain, { maxTries: 3 }).kick();
    expect(codes(store, e)).toEqual(['CHAIN_UNAVAILABLE']);
    expect(chain.signed).toHaveLength(0);
  });

  it('never reports failed once a transaction is signed, because it may still be mined', async () => {
    const store = newStore();
    const chain = new FakeChain();
    chain.unavailable.getReceipt = true;
    const e = submit(store, envelope([payEth(0, [[ALEX, '0.01']])]));
    const runner = runnerOn(store, chain, { maxTries: 1 });
    const done = runner.kick();
    await vi.waitFor(() => expect(statuses(store, e)).toEqual(['signed']));
    await new Promise((r) => setTimeout(r, 30));
    expect(statuses(store, e)).toEqual(['signed']);
    expect(store.allReports()).toHaveLength(0);

    chain.unavailable.getReceipt = false;
    await vi.waitFor(() => expect(statuses(store, e)).toEqual(['executed']));
    await runner.stop();
    await done;
    expect(chain.signed).toHaveLength(1);
  });
});

describe('crashes (nothing twice, rule 7)', () => {
  /** Runs until `chain` hangs at the given call, as a dead process would, then starts a new runner on the same store. */
  const crashThenRestart = async (hang: 'prepareAndSign' | 'broadcast' | 'getReceipt', e: HandoffEnvelope) => {
    const store = newStore();
    const chain = new FakeChain();
    submit(store, e);
    payingFor(chain, e);
    chain.hang[hang] = true;
    void runnerOn(store, chain).kick();
    await new Promise((r) => setTimeout(r, 20));
    const before = store.stepsOf(e.request_id)[0]?.status;
    chain.hang = {};
    await runnerOn(store, chain).kick();
    return { store, chain, before };
  };

  it('while signing: signs on restart, and pays once', async () => {
    const e = envelope([payUsdc(0, [[ALEX, '10']])]);
    const { store, chain, before } = await crashThenRestart('prepareAndSign', e);
    expect(before).toBe('approved');
    expect(chain.signed).toHaveLength(1);
    expect(statuses(store, e)).toEqual(['executed']);
  });

  it('after sending, before the result is stored: finds the transaction and signs nothing new', async () => {
    const e = envelope([payUsdc(0, [[ALEX, '10']])]);
    const { store, chain, before } = await crashThenRestart('broadcast', e);
    expect(before).toBe('signed');
    expect(chain.signed).toHaveLength(1);
    expect(new Set(chain.broadcasts).size).toBe(1);
    expect(statuses(store, e)).toEqual(['executed']);
    expect(store.allReports()).toHaveLength(1);
  });

  it('after signing, before anything was sent: sends the saved transaction, not a new one', async () => {
    const e = envelope([payUsdc(0, [[ALEX, '10']])]);
    const store = newStore();
    const chain = new FakeChain();
    submit(store, e);
    payingFor(chain, e);
    chain.hang.getReceipt = true;
    void runnerOn(store, chain).kick();
    await vi.waitFor(() => expect(statuses(store, e)).toEqual(['signed']));
    expect(chain.broadcasts).toHaveLength(0);
    const saved = store.stepsOf(e.request_id)[0]?.raw_tx;
    chain.hang = {};
    await runnerOn(store, chain).kick();
    expect(chain.signed).toHaveLength(1);
    expect(chain.broadcasts).toEqual([saved]);
    expect(statuses(store, e)).toEqual(['executed']);
  });

  it('between two steps: the finished step is not repeated', async () => {
    const e = envelope([payEth(0, [[ALEX, '0.01']]), payEth(1, [[BOB, '0.02']])]);
    const store = newStore();
    const chain = new FakeChain();
    submit(store, e);
    let calls = 0;
    const stopsAtSecond: Approver = {
      approve: () => (++calls === 1 ? Promise.resolve(true) : new Promise(() => {})),
    };
    void runnerOn(store, chain, { approver: stopsAtSecond }).kick();
    await vi.waitFor(() => expect(statuses(store, e)).toEqual(['executed', 'pending']));
    await runnerOn(store, chain).kick();
    expect(statuses(store, e)).toEqual(['executed', 'executed']);
    expect(chain.signed).toHaveLength(2);
    expect(store.allReports()).toHaveLength(2);
  });

  it('a repeat run of a finished request does nothing', async () => {
    const store = newStore();
    const chain = new FakeChain();
    submit(store, envelope([payEth(0, [[ALEX, '0.01']])]));
    await runnerOn(store, chain).kick();
    await runnerOn(store, chain).kick();
    expect(chain.signed).toHaveLength(1);
    expect(store.allReports()).toHaveLength(1);
  });
});

describe('logs', () => {
  it('hold no amounts, addresses or hashes', async () => {
    const store = newStore();
    const chain = new FakeChain();
    const lines: string[] = [];
    const log: Logger = (code, fields) => lines.push(JSON.stringify({ code, ...fields }));
    submit(store, envelope([payUsdc(0, [[ALEX, '10.5']])]));
    await runnerOn(store, chain, { log }).kick();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toMatch(/0x[0-9a-fA-F]{8}|10\.5/);
  });

  it('an unexpected error is logged by code, and stays saved for a retry', async () => {
    const store = newStore();
    const lines: string[] = [];
    const log: Logger = (code) => lines.push(code);
    const e = submit(store, envelope([payEth(0, [[ALEX, '0.01']])]));
    const runner = new Runner({
      store,
      walletAddress: WALLET,
      approver: autoApprove,
      gatewayFor: () => {
        throw new Error(`secret ${ALEX}`);
      },
      log,
      onReportQueued: () => {},
    });
    await runner.kick();
    expect(lines).toEqual(['runner_error']);
    expect(statuses(store, e)).toEqual(['pending']);
  });
});
