// The decoder fed tampered bytes. The wallet's own builder never makes these, so only a test like this can show the rules work:
// each case is what a bug, or a compromised build, would try to get signed.
import { describe, expect, it } from 'vitest';
import { concat, encodeAbiParameters, encodeFunctionData, erc20Abi, parseAbi, parseEther, type Hex } from 'viem';
import { EXECUTOR_ABI, DELEGATION_MANAGER_ABI } from '../../src/autopay/abi.js';
import { decodeRegister } from '../../src/autopay/autopay-k.js';
import { decodeCancelBatch } from '../../src/autopay/cancel-l.js';
import { ccipMessage, decodeBridgeBatch } from '../../src/bridge/bridge-j.js';
import { redeemCalldata } from '../../src/chain/redeem.v2.js';
import { encodeExecuteBatch } from '../../src/payments/payment-i.js';
import { CCIP } from '../../src/schemas/bridge.v2.js';
import type { Intent } from '../../src/schemas/intent.v2.js';
import { USDC } from '../../src/schemas/intent.v2.js';
import { ALEX, ARBITRUM, BASE, BOB, WALLET, autopay, bridge, envelope } from '../support/envelopes.js';
import { toPlan } from '../../src/mapping/to-plan.js';

const ATTACKER: Hex = '0x000000000000000000000000000000000000bad0';

describe('a bridge', () => {
  const intent = bridge(0, '10', [1]);
  const fee = parseEther('0.001');
  const router = CCIP[ARBITRUM].router;
  const selector = CCIP[BASE].selector;
  const ROUTER = parseAbi([
    'struct TokenAmount { address token; uint256 amount; }',
    'struct Message { bytes receiver; bytes data; TokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }',
    'function ccipSend(uint64 destSelector, Message message) payable returns (bytes32)',
  ]);
  const message = ccipMessage(intent, WALLET);
  const approve = (spender: Hex, value: bigint, token: Hex = USDC[ARBITRUM]) => ({
    target: token,
    value: 0n,
    callData: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, value] }),
  });
  const send = (m: typeof message = message, value = fee, sel = selector, to: Hex = router) => ({
    target: to,
    value,
    callData: encodeFunctionData({ abi: ROUTER, functionName: 'ccipSend', args: [sel, m] }),
  });
  const judge = (calls: Parameters<typeof encodeExecuteBatch>[0]) =>
    decodeBridgeBatch(encodeExecuteBatch(calls), intent, WALLET, fee);

  it('accepts the correct batch', () => {
    expect(judge([approve(router, 10_000_000n), send()])).not.toBeNull();
  });
  it.each([
    [
      'sends to someone else (J5: the chain would allow it)',
      () => [
        approve(router, 10_000_000n),
        send({ ...message, receiver: encodeAbiParameters([{ type: 'address' }], [ATTACKER]) }),
      ],
    ],
    ['leaves an unlimited approval (J7)', () => [approve(router, 2n ** 256n - 1n), send()]],
    ['approves someone other than the router', () => [approve(ATTACKER, 10_000_000n), send()]],
    ['overpays the fee (J3: the router keeps it)', () => [approve(router, 10_000_000n), send(message, fee + 1n)]],
    ['goes to the wrong chain', () => [approve(router, 10_000_000n), send(message, fee, CCIP[11155111].selector)]],
    ['sends to a fake router', () => [approve(router, 10_000_000n), send(message, fee, selector, ATTACKER)]],
    [
      'bridges more than was asked',
      () => [
        approve(router, 10_000_000n),
        send({ ...message, tokenAmounts: [{ token: USDC[ARBITRUM], amount: 99_000_000n }] }),
      ],
    ],
    ['attaches a memo (rule 1)', () => [approve(router, 10_000_000n), send({ ...message, data: '0x1234' })]],
    ['pays the fee in a token', () => [approve(router, 10_000_000n), send({ ...message, feeToken: USDC[ARBITRUM] })]],
    ['has an extra call', () => [approve(router, 10_000_000n), send(), approve(ATTACKER, 1n)]],
    ['has its calls the wrong way round', () => [send(), approve(router, 10_000_000n)]],
  ])('refuses a batch that %s', (_name, calls) => {
    expect(judge(calls())).toBeNull();
  });
});

describe('registering an autopay', () => {
  const start = 1_900_000_000;
  const k = autopay(0, start, [[ALEX, '10']]);
  const intent = toPlan(envelope([k])).steps[0]?.intent as unknown as Intent;
  const executor: Hex = '0x00000000000000000000000000000000000000aa';
  const delegation = (over: { delegator?: Hex; delegate?: Hex } = {}) => ({
    delegate: over.delegate ?? executor,
    delegator: over.delegator ?? WALLET,
    authority: `0x${'ff'.repeat(32)}` as Hex,
    caveats: [],
    salt: '1',
    signature: '0x12' as Hex,
  });
  const data = (o: { start?: number; runs?: number; d?: ReturnType<typeof delegation> } = {}) =>
    encodeFunctionData({
      abi: EXECUTOR_ABI,
      functionName: 'register',
      args: [
        BigInt(o.start ?? start),
        BigInt(k.schedule.interval_seconds),
        BigInt(k.schedule.late_window_seconds),
        BigInt(o.runs ?? k.schedule.max_runs),
        redeemCalldata(intent, o.d ?? delegation()),
      ],
    });

  it('accepts the correct call, and reads the batch inside the permission', () => {
    expect(decodeRegister(data(), k, WALLET, executor)).toHaveLength(2);
  });
  it.each([
    ['a changed start time', () => data({ start: start + 1 })],
    ['more runs than promised', () => data({ runs: k.schedule.max_runs + 1 })],
    ['a permission from someone else', () => data({ d: delegation({ delegator: ATTACKER }) })],
    ['a permission to another contract', () => data({ d: delegation({ delegate: ATTACKER }) })],
    ['bytes that are not a register call', () => '0xdeadbeef' as Hex],
  ])('refuses %s', (_name, bytes) => {
    expect(decodeRegister(bytes(), k, WALLET, executor)).toBeNull();
  });
});

describe('a cancel', () => {
  const executor: Hex = '0x00000000000000000000000000000000000000aa';
  const manager: Hex = '0x00000000000000000000000000000000000000bb';
  const planId = `0x${'ab'.repeat(32)}` as Hex;
  const cancelCall = (id: Hex = planId, target: Hex = executor) => ({
    target,
    value: 0n,
    callData: encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'cancel', args: [id] }),
  });
  const disable = (delegator: Hex = WALLET, delegate: Hex = executor, target: Hex = manager) => ({
    target,
    value: 0n,
    callData: encodeFunctionData({
      abi: DELEGATION_MANAGER_ABI,
      functionName: 'disableDelegation',
      args: [{ delegate, delegator, authority: `0x${'ff'.repeat(32)}`, caveats: [], salt: 1n, signature: '0x12' }],
    }),
  });
  const judge = (calls: Parameters<typeof encodeExecuteBatch>[0]) =>
    decodeCancelBatch(encodeExecuteBatch(calls), planId, WALLET, executor, manager);

  it('accepts the correct batch, which moves nothing', () => {
    expect(judge([cancelCall(), disable()])).toEqual([]);
  });
  it.each([
    ['cancels another plan', () => [cancelCall(`0x${'cd'.repeat(32)}`), disable()]],
    ['calls a fake executor', () => [cancelCall(planId, ATTACKER), disable()]],
    ['disables someone else’s permission', () => [cancelCall(), disable(BOB)]],
    ['calls a fake manager', () => [cancelCall(), disable(WALLET, executor, ATTACKER)]],
    ['also moves money', () => [cancelCall(), disable(), { target: ATTACKER, value: 1n, callData: '0x' as Hex }]],
    [
      'carries an unknown call',
      () => [cancelCall(), { target: ATTACKER, value: 0n, callData: concat(['0xdeadbeef']) }],
    ],
  ])('refuses a batch that %s', (_name, calls) => {
    expect(judge(calls())).toBeNull();
  });
});
