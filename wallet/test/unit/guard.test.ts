// The check before signing: each way the intent, the decoded bytes and the simulation can disagree.
import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, type Hex, type Log } from 'viem';
import { autoApprove, type Approver } from '../../src/approval.js';
import { EXECUTOR_ABI } from '../../src/autopay/abi.js';
import { judge, sameMovements, type Check } from '../../src/guard/check.js';
import { decodeCall, decodeExecuteBatch, ETH, movementsOfCalls, movementsOfLogs } from '../../src/guard/decode.js';
import { silentLogger } from '../../src/log.js';
import { callsOf, encodeExecuteBatch } from '../../src/payments/payment-i.js';
import { Runner } from '../../src/runner/runner.js';
import { USDC } from '../../src/schemas/intent.v2.js';
import { Store } from '../../src/store/store.js';
import { ALEX, BASE, BOB, envelope, payEth, payUsdc, WALLET } from '../support/envelopes.js';
import { FakeChain, transferLog } from '../support/fake-chain.js';
import { tempDb } from '../support/temp-db.js';

const token = USDC[BASE];

describe('the decoder', () => {
  it('reads who a USDC batch pays from the raw bytes', () => {
    const data = encodeExecuteBatch(
      callsOf(
        payUsdc(0, [
          [ALEX, '10'],
          [BOB, '20.5'],
        ]),
      ),
    );
    const calls = decodeExecuteBatch(data)?.map(decodeCall) ?? [];
    expect(movementsOfCalls(calls, WALLET)).toEqual([
      { token, from: WALLET, to: ALEX, value: 10_000_000n },
      { token, from: WALLET, to: BOB, value: 20_500_000n },
    ]);
  });

  it('reads ETH transfers', () => {
    const data = encodeExecuteBatch(callsOf(payEth(0, [[ALEX, '0.5']])));
    const calls = decodeExecuteBatch(data)?.map(decodeCall) ?? [];
    expect(movementsOfCalls(calls, WALLET)).toEqual([
      { token: ETH, from: WALLET, to: ALEX, value: 500_000_000_000_000_000n },
    ]);
  });

  it('refuses bytes that are not a batch', () => {
    expect(decodeExecuteBatch('0x12345678')).toBeNull();
  });

  it('marks a call it does not recognise as unknown', () => {
    expect(decodeCall({ target: ALEX, value: 0n, callData: '0xdeadbeef' }).kind).toBe('unknown');
  });

  it('does not treat a token call that also sends ETH as a plain transfer', () => {
    const callData = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ALEX, 1n] });
    expect(decodeCall({ target: token, value: 5n, callData }).kind).toBe('unknown');
  });

  it.each([
    ['0xfffffffffffffffffffffffffffffffffffffffe', 'Sepolia'],
    ['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'Base and Arbitrum Sepolia'],
  ])('reads a traced ETH move from %s (%s)', (address) => {
    const log = {
      address,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: WALLET, to: ALEX } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [7n]),
    } as unknown as Log;
    expect(movementsOfLogs([log])).toEqual([{ token: ETH, from: WALLET, to: ALEX, value: 7n }]);
  });
});

describe('comparing movements exactly', () => {
  const m = (to: Hex, value: bigint) => ({ token: token as Hex, from: WALLET, to, value });
  it('accepts the same ones in another order', () => {
    expect(sameMovements([m(ALEX, 1n), m(BOB, 2n)], [m(BOB, 2n), m(ALEX, 1n)])).toBe(true);
  });
  it.each([
    ['a missing payment', [m(ALEX, 1n)]],
    ['an extra payment', [m(ALEX, 1n), m(BOB, 2n), m(BOB, 2n)]],
    ['a wrong amount', [m(ALEX, 1n), m(BOB, 3n)]],
    ['a wrong person', [m(ALEX, 1n), m(ALEX, 2n)]],
  ])('refuses %s', (_name, got) => {
    expect(sameMovements([m(ALEX, 1n), m(BOB, 2n)], got)).toBe(false);
  });
  it('does not confuse ETH with a token of the same amount', () => {
    expect(sameMovements([{ token: ETH, from: WALLET, to: ALEX, value: 1n }], [m(ALEX, 1n)])).toBe(false);
  });
});

describe('judging a check', () => {
  const want = [{ token: token as Hex, from: WALLET, to: ALEX, value: 10n }];
  const check: Check = {
    blocks: [{ calls: [{ from: WALLET, to: WALLET, data: '0x' }] }],
    decode: () => want,
    movements: want,
    events: [],
    summary: [],
  };
  const paid = [transferLog(token, WALLET, ALEX, 10n)];

  it('passes when all three agree', () => {
    expect(judge(check, want, [[{ status: 'success', logs: paid }]], WALLET)).toBeNull();
  });
  it('fails when the bytes do not decode', () => {
    expect(judge(check, null, [[{ status: 'success', logs: paid }]], WALLET)).toBe('DECODE_MISMATCH');
  });
  it('fails when the bytes pay someone else, even if the simulation looks right', () => {
    const tampered = [{ ...want[0]!, to: BOB }];
    expect(judge(check, tampered, [[{ status: 'success', logs: paid }]], WALLET)).toBe('DECODE_MISMATCH');
  });
  it('fails when the simulation reverts', () => {
    expect(judge(check, want, [[{ status: 'failure', logs: [] }]], WALLET)).toBe('SIMULATION_FAILED');
  });
  it('fails when the simulation returns too few results', () => {
    expect(judge(check, want, [[]], WALLET)).toBe('SIMULATION_FAILED');
  });
  it('fails when the simulation succeeds but moves nothing (B1)', () => {
    expect(judge(check, want, [[{ status: 'success', logs: [] }]], WALLET)).toBe('SIMULATION_MISMATCH');
  });
  it('fails when the simulation moves extra money out of the wallet', () => {
    const logs = [...paid, transferLog(token, WALLET, BOB, 1n)];
    expect(judge(check, want, [[{ status: 'success', logs }]], WALLET)).toBe('SIMULATION_MISMATCH');
  });
  it('ignores money moving between other people', () => {
    const logs = [...paid, transferLog(token, ALEX, BOB, 1n)];
    expect(judge(check, want, [[{ status: 'success', logs }]], WALLET)).toBeNull();
  });
  it('fails when a forbidden event appears, such as a run paying after a cancel', () => {
    const executor = '0x00000000000000000000000000000000000000aa' as Hex;
    const planId = `0x${'ab'.repeat(32)}` as Hex;
    const executed = {
      address: executor,
      topics: encodeEventTopics({ abi: EXECUTOR_ABI, eventName: 'Executed', args: { intentId: planId } }),
      data: encodeAbiParameters([{ type: 'uint64' }, { type: 'uint64' }], [0n, 1n]),
    } as unknown as Log;
    const withForbidden: Check = { ...check, forbidden: [{ name: 'Executed', planId, address: executor }] };
    const logs = [...paid, executed];
    expect(judge(withForbidden, want, [[{ status: 'success', logs }]], WALLET)).toBe('SIMULATION_MISMATCH');
    expect(judge(withForbidden, want, [[{ status: 'success', logs: paid }]], WALLET)).toBeNull();
  });

  it('lets a probe fail, because showing that is its job', () => {
    const withProbe: Check = {
      ...check,
      blocks: [...check.blocks, { calls: [{ from: ALEX, to: WALLET, data: '0x' }], probe: true }],
    };
    const results = [[{ status: 'success' as const, logs: paid }], [{ status: 'failure' as const, logs: [] }]];
    expect(judge(withProbe, want, results, WALLET)).toBeNull();
  });
});

describe('the check in the lifecycle', () => {
  const run = async (chain: FakeChain, approver: Approver = autoApprove, intents = [payUsdc(0, [[ALEX, '10']])]) => {
    const store = new Store(tempDb());
    const e = envelope(intents);
    store.insertRequest(e, '2026-11-06T10:00:00.000Z');
    await new Runner({
      store,
      walletAddress: WALLET,
      approver,
      gatewayFor: () => chain,
      log: silentLogger,
      onReportQueued: () => {},
      pollMs: 1,
      maxTries: 2,
    }).kick();
    return store.stepsOf(e.request_id)[0];
  };

  it.each([
    ['unavailable', 'SIMULATION_UNAVAILABLE'],
    ['fails', 'SIMULATION_FAILED'],
    ['moves-nothing', 'SIMULATION_MISMATCH'],
    ['pays-someone-else', 'SIMULATION_MISMATCH'],
  ] as const)(
    'simulation %s: stops with %s after the approval (privacy fix 2). Never signs, never upgrades',
    async (simulation, code) => {
      const chain = new FakeChain();
      chain.code = undefined;
      chain.simulation = simulation;
      const approve = vi.fn(async () => true);
      const step = await run(chain, { approve });
      expect(step?.status).toBe('failed');
      expect(step?.error_code).toBe(code);
      expect(approve).toHaveBeenCalledTimes(1);
      expect(chain.simulated).toBeGreaterThan(0);
      expect(chain.signed).toHaveLength(0);
      expect(chain.upgrades).toBe(0);
      expect(chain.broadcasts).toHaveLength(0);
    },
  );

  it('privacy fix 2: a refused request is never simulated (the RPC never sees the batch)', async () => {
    for (const intents of [[payUsdc(0, [[ALEX, '10']])], [payEth(0, [[ALEX, '0.01']])]]) {
      const chain = new FakeChain();
      const step = await run(chain, { approve: async () => false }, intents);
      expect(step?.error_code).toBe('USER_REJECTED');
      expect(chain.simulated).toBe(0);
      expect(chain.signed).toHaveLength(0);
    }
  });

  it('has no fallback: no simulation, no payment, even when everything else works', async () => {
    const chain = new FakeChain();
    chain.simulation = 'unavailable';
    const step = await run(chain);
    expect(step?.error_code).toBe('SIMULATION_UNAVAILABLE');
    expect(chain.broadcasts).toHaveLength(0);
  });

  it('privacy fix 2: runs after the approval, and the approval shows what was decoded', async () => {
    const chain = new FakeChain();
    const simulatedAtApproval: number[] = [];
    const summaries: string[][] = [];
    const approver: Approver = {
      approve: async ({ summary }) => {
        simulatedAtApproval.push(chain.simulated);
        summaries.push(summary);
        return true;
      },
    };
    await run(chain, approver, [
      payUsdc(0, [
        [ALEX, '10'],
        [BOB, '20.5'],
      ]),
    ]);
    expect(simulatedAtApproval).toEqual([0]);
    expect(chain.simulated).toBe(1);
    expect(summaries[0]).toEqual(['Send 10 USDC to 0x15d3…6A65', 'Send 20.5 USDC to 0x9965…A4dc']);
  });
});
