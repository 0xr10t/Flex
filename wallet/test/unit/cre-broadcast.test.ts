/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi } from 'viem';
import { SIMULATION_FORWARDERS } from '../../src/autopay/local-cre.js';
import { EXECUTOR_ABI } from '../../src/autopay/abi.js';
import { verifiedIntent } from '../../src/autopay/autopay-k.js';
import { redeemCalldata } from '../../src/chain/redeem.v2.js';
import { autopay, envelope, WALLET, ALEX } from '../support/envelopes.js';
// @ts-expect-error Host helpers also execute directly under Node.
import { candidatePlans, runTestnetChain, receiptOutcome } from '../../../scripts/cre-broadcast.mjs';

const executor = `0x${'ab'.repeat(20)}` as const;
const abi = [
  ...EXECUTOR_ABI,
  ...parseAbi(['function owner() view returns (address)', 'function delegationManager() view returns (address)']),
];
function setup() {
  const now = Math.floor(Date.now() / 1000),
    start = now - 60;
  const redeem = redeemCalldata(
    verifiedIntent(envelope([autopay(0, start, [[ALEX, '1']], { interval: 3600, late: 3599 })]), 0),
    {
      delegate: executor,
      delegator: WALLET,
      authority: `0x${'ff'.repeat(32)}`,
      caveats: [],
      salt: '1',
      signature: '0x12',
    },
  );
  const plan = {
    id: keccak256(redeem),
    redeem,
    startAt: String(start),
    interval: '3600',
    lateWindow: '3599',
    maxRuns: '3',
    lastSlot: '-1',
    cancelled: false,
  };
  const chain = {
    chainId: 84532,
    selector: '10344971235874465080',
    executor,
    forwarder: SIMULATION_FORWARDERS[84532],
    deploymentBlock: '1',
    snapshot: { blockNumber: '10', blockHash: `0x${'aa'.repeat(32)}`, plans: [plan] },
    simulation: { urlsSecret: 'SIM_URLS', quorum: 2 },
  };
  let lastSlot = -1n;
  const rpc = vi.fn(async (method: string, params: any[]) => {
    if (method === 'eth_chainId') return '0x14a34';
    if (method === 'eth_getCode') return '0x1234';
    if (method === 'eth_getTransactionCount') return '0x1';
    if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
    if (method === 'eth_gasPrice') return '0x1';
    if (method === 'eth_getTransactionReceipt') return null;
    if (method === 'eth_call') {
      const { functionName } = decodeFunctionData({ abi, data: params[0].data });
      const result =
        functionName === 'owner'
          ? WALLET
          : functionName === 'delegationManager'
            ? ALEX
            : functionName === 'getForwarderAddress'
              ? chain.forwarder
              : functionName === 'getExpectedAuthor'
                ? `0x${'00'.repeat(20)}`
                : functionName === 'getExpectedWorkflowName'
                  ? `0x${'00'.repeat(10)}`
                  : functionName === 'getExpectedWorkflowId'
                    ? `0x${'00'.repeat(32)}`
                    : [WALLET, BigInt(start), 3600n, 3599n, 3n, 0n, lastSlot, false];
      return encodeFunctionResult({ abi, functionName, result: result as never });
    }
    throw new Error('UNEXPECTED_RPC');
  });
  const dry = {
    mode: 'testnet-dry-run',
    due: 1,
    results: [{ chainId: 84532, id: plan.id, slot: '0', status: 'would_execute', gasLimit: '500000' }],
  };
  const journal = { version: 1, entries: {} };
  const save = vi.fn();
  return {
    chain,
    plan,
    now: BigInt(now),
    rpc,
    dry,
    journal,
    save,
    config: { schedule: '*/30 * * * * *', walletAddress: WALLET },
    paid: () => {
      lastSlot = 0n;
    },
  };
}

describe('local CRE broadcast orchestration', () => {
  it('filters unrelated wallets before spending transmitter gas', () => {
    const h = setup();
    expect(candidatePlans(h.chain, WALLET, BigInt(h.now))).toHaveLength(1);
    expect(candidatePlans(h.chain, ALEX, BigInt(h.now))).toHaveLength(0);
  });
  it('journals before the CLI and blocks another submission after an uncertain exit, including restart', async () => {
    const h = setup();
    const simulate = vi.fn(async (config) => {
      if (config.mode === 'testnet-dry-run') return h.dry;
      expect(Object.values(h.journal.entries)).toMatchObject([{ id: h.plan.id, slot: '0', state: 'started' }]);
      expect(config.expectedRun).toEqual({ id: h.plan.id, slot: '0' });
      throw new Error('CRE_COMMAND_FAILED');
    });
    await expect(runTestnetChain({ ...h, simulate, transmitter: WALLET, broadcast: true })).rejects.toThrow(
      'CRE_COMMAND_FAILED',
    );
    const restarted = JSON.parse(JSON.stringify(h.journal));
    expect(
      await runTestnetChain({ ...h, journal: restarted, simulate, transmitter: WALLET, broadcast: true }),
    ).toMatchObject({ code: 'SUBMISSION_UNKNOWN' });
    expect(simulate).toHaveBeenCalledTimes(2);
    h.paid();
    expect(
      await runTestnetChain({ ...h, journal: restarted, simulate, transmitter: WALLET, broadcast: true }),
    ).toMatchObject({ status: 'idle' });
    expect(simulate).toHaveBeenCalledTimes(2);
  });
  it('keeps dry run read-only and waits for pending MetaMask transactions', async () => {
    const h = setup(),
      simulate = vi.fn(async () => h.dry);
    await runTestnetChain({ ...h, simulate, transmitter: WALLET, broadcast: false });
    expect(h.journal.entries).toEqual({});
    expect(simulate).toHaveBeenCalledTimes(1);
    const rpc = async (method: string, params: any[]) =>
      method === 'eth_getTransactionCount' && params[1] === 'pending' ? '0x2' : h.rpc(method, params);
    expect(await runTestnetChain({ ...h, rpc, simulate, transmitter: WALLET, broadcast: true })).toMatchObject({
      code: 'TRANSMITTER_BUSY',
    });
    expect(h.journal.entries).toEqual({});
  });
  it('does not treat a successful forwarder receipt without the payment event as payment', () => {
    const h = setup(),
      tx = `0x${'cd'.repeat(32)}`;
    expect(
      receiptOutcome({ status: '0x1', transactionHash: tx, from: WALLET, to: h.chain.forwarder, logs: [] }, h.chain, {
        id: h.plan.id,
        slot: '0',
        transmitter: WALLET,
        tx,
      }),
    ).toBe('receiver_failed');
  });
});
