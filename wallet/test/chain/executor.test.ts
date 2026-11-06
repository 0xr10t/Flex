// IntentExecutorV3 with MetaMask's real contracts, covering the gaps the lab left: a list of 50, one recipient, ETH, the exact
// edges of the time window, and a run with too little money. These runs go through a stand-in forwarder.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseEther,
  parseEventLogs,
  parseUnits,
  type Hex,
} from 'viem';
import { EXECUTOR_ABI } from '../../src/autopay/abi.js';
import { delegationFromRedeem, planIdOf, redeemFor, signAutopayDelegation } from '../../src/autopay/delegation.js';
import { toPlan } from '../../src/mapping/to-plan.js';
import type { AutopayK, HandoffEnvelope, Payee } from '../../src/schemas/envelope.js';
import { BASE, envelope, eth, usdc, WALLET } from '../support/envelopes.js';
import type { Intent } from '../../src/schemas/intent.v2.js';
import { artifact, startChain, userAccount, type LocalChain } from './harness.js';
import { EIP7702_DELEGATOR } from '../../src/chain/addresses.js';

const ALEX: Hex = '0x000000000000000000000000000000000000a11c';
const FEE_TO: Hex = '0x000000000000000000000000000000000000fee0';
const address = (n: number) => `0x${(0x100000 + n).toString(16).padStart(40, '0')}` as Hex;
const units = (v: string) => parseUnits(v, 6);

let chain: LocalChain;
let executor: Hex;
let forwarder: Hex;
let snap: string;

beforeAll(async () => {
  chain = await startChain(BASE);
  forwarder = await chain.deploy('TestHelpers.sol', 'MockForwarder');
  executor = await chain.deploy('IntentExecutorV3.sol', 'IntentExecutorV3', [forwarder, chain.env.DelegationManager]);
  await chain.mintUsdc(WALLET, units('1000000'));
  const auth = await userAccount.signAuthorization({
    address: EIP7702_DELEGATOR,
    chainId: BASE,
    nonce: (await chain.pub.getTransactionCount({ address: WALLET })) + 1,
  });
  const user = userClient();
  await chain.pub.waitForTransactionReceipt({
    hash: await user.sendTransaction({ authorizationList: [auth], to: WALLET, data: '0x' }),
  });
});
afterAll(() => chain?.stop());
beforeEach(async () => {
  snap = await chain.snapshot();
});
afterEach(async () => {
  await chain.revert(snap);
});

function userClient() {
  return chain.walletFor(userAccount);
}

interface Options {
  recipients?: Payee[];
  token?: 'USDC' | 'ETH';
  interval?: number;
  late?: number;
  runs?: number;
  start?: number;
  signChainId?: number;
}

/** Builds a `k`, signs it, and registers it from the user's account. */
async function register(o: Options = {}) {
  const now = await chain.now();
  const start = o.start ?? now + 3600;
  const interval = o.interval ?? 86400;
  const late = o.late ?? 3600;
  const runs = o.runs ?? 3;
  const token = o.token ?? 'USDC';
  const money = token === 'USDC' ? usdc : eth;
  const recipients = o.recipients ?? [{ recipient: ALEX, amount: money(token === 'USDC' ? '10' : '0.01') }];
  const decimals = token === 'USDC' ? 6 : 18;
  const feeAmount = money(token === 'USDC' ? '0.05' : '0.00002');
  const perRun = recipients.reduce((sum, r) => sum + BigInt(r.amount.base_units), BigInt(feeAmount.base_units));
  const fmt = (v: bigint) => {
    const s = v.toString().padStart(decimals + 1, '0');
    const frac = s.slice(-decimals).replace(/0+$/, '');
    return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals);
  };
  const k: AutopayK = {
    intent_id: 'k',
    step: 0,
    depends_on: [],
    autopay_id: 'ap_0123456789ab',
    token,
    token_address: token === 'USDC' ? chain.usdc : null,
    chain_id: BASE,
    recipients,
    fee: { to: FEE_TO, amount: feeAmount },
    schedule: {
      start_at: start,
      interval_seconds: interval,
      max_runs: runs,
      late_window_seconds: late,
      end_at: start + interval * (runs - 1) + late,
    },
    limits: { max_per_run: money(fmt(perRun)), max_total: money(fmt(perRun * BigInt(runs))) },
    executor: 'chainlink-cre',
  };
  const e: HandoffEnvelope = envelope([k]);
  const intent = toPlan(e).steps[0]?.intent as unknown as Intent;
  const delegation = await signAutopayDelegation(
    {
      intent,
      delegator: WALLET,
      executor,
      chainId: o.signChainId ?? BASE,
      env: chain.env,
      startAt: start,
      endAt: k.schedule.end_at,
    },
    (typed) => userAccount.signTypedData(typed as never),
  );
  const redeem = redeemFor(intent, delegation);
  const user = userClient();
  const hash = await user.sendTransaction({
    to: executor,
    data: encodeFunctionData({
      abi: EXECUTOR_ABI,
      functionName: 'register',
      args: [BigInt(start), BigInt(interval), BigInt(late), BigInt(runs), redeem],
    }),
  });
  const receipt = await chain.pub.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  return { redeem, start, interval, late, runs, registerGas: receipt.gasUsed as bigint, id: planIdOf(redeem) };
}

const reportOf = (redeem: Hex) => encodeAbiParameters([{ type: 'bytes' }], [redeem]);

/** Delivers a CRE report at the current time. Success is an `Executed` event, never the receipt (A.5 rule 5). */
async function run(redeem: Hex) {
  const { abi } = artifact('TestHelpers.sol', 'MockForwarder');
  try {
    const hash = await chain.deployer.writeContract({
      address: forwarder,
      abi,
      functionName: 'deliver',
      args: [executor, `0x${'11'.repeat(32)}`, `0x${'00'.repeat(10)}`, WALLET, reportOf(redeem)],
      gas: 9_000_000n,
    });
    const receipt = await chain.pub.waitForTransactionReceipt({ hash });
    const events = parseEventLogs({ abi: EXECUTOR_ABI, logs: receipt.logs, eventName: 'Executed' });
    return { paid: events.length === 1, gas: receipt.gasUsed as bigint };
  } catch {
    return { paid: false, gas: 0n };
  }
}

describe('a list of 50 people (C-1)', () => {
  it('registers, runs inside the CRE limits, and pays everyone their own amount', async () => {
    const recipients = Array.from({ length: 50 }, (_, n) => ({
      recipient: address(n),
      amount: usdc(String(n + 1)),
    }));
    const plan = await register({ recipients });
    const reportBytes = (reportOf(plan.redeem).length - 2) / 2;
    await chain.setTime(plan.start + 30);
    const first = await run(plan.redeem);
    expect(first.paid).toBe(true);
    expect(await chain.usdcOf(address(0))).toBe(units('1'));
    expect(await chain.usdcOf(address(49))).toBe(units('50'));
    expect(await chain.usdcOf(FEE_TO)).toBe(units('0.05'));

    await chain.setTime(plan.start + plan.interval + 30);
    const second = await run(plan.redeem);
    expect(second.paid).toBe(true);

    process.stdout.write(
      `\n[measured] 50 recipients: register ${plan.registerGas} gas, first run ${first.gas} gas, later run ${second.gas} gas, report ${reportBytes} bytes\n`,
    );
    expect(reportBytes).toBeLessThan(50_000);
    expect(first.gas).toBeLessThan(10_000_000n);
    expect(plan.registerGas).toBeLessThan(10_000_000n);
  });
});

describe('gaps from the lab', () => {
  it('one recipient plus a fee', async () => {
    const plan = await register();
    await chain.setTime(plan.start + 30);
    expect((await run(plan.redeem)).paid).toBe(true);
    expect(await chain.usdcOf(ALEX)).toBe(units('10'));
    expect(await chain.usdcOf(FEE_TO)).toBe(units('0.05'));
  });

  it('an ETH autopay', async () => {
    const before = await chain.ethOf(ALEX);
    const plan = await register({ token: 'ETH' });
    await chain.setTime(plan.start + 30);
    expect((await run(plan.redeem)).paid).toBe(true);
    expect((await chain.ethOf(ALEX)) - before).toBe(parseEther('0.01'));
  });

  it('pays at exactly start_at', async () => {
    const plan = await register();
    await chain.rpc('evm_setNextBlockTimestamp', [plan.start]);
    expect((await run(plan.redeem)).paid).toBe(true);
  });

  it('pays at exactly the last second of the last window (OQ-10)', async () => {
    const plan = await register({ runs: 1 });
    await chain.rpc('evm_setNextBlockTimestamp', [plan.start + plan.late]);
    expect((await run(plan.redeem)).paid).toBe(true);
  });

  it('does not pay one second before start_at, or one second after the window', async () => {
    const plan = await register({ runs: 2 });
    await chain.rpc('evm_setNextBlockTimestamp', [plan.start - 1]);
    expect((await run(plan.redeem)).paid).toBe(false);
    await chain.rpc('evm_setNextBlockTimestamp', [plan.start + plan.late + 1]);
    expect((await run(plan.redeem)).paid).toBe(false);
  });

  it('the signed permission itself refuses outside its times, whatever the executor does (B7a)', async () => {
    const plan = await register({ runs: 1 });
    const asExecutor = () =>
      chain.pub.call({ account: executor, to: chain.env.DelegationManager as Hex, data: plan.redeem });
    await expect(asExecutor()).rejects.toThrow();
    await chain.setTime(plan.start + plan.late + 2);
    await expect(asExecutor()).rejects.toThrow();
  });

  it('a late window equal to the interval', async () => {
    const plan = await register({ interval: 3600, late: 3600 });
    await chain.setTime(plan.start + 3599);
    expect((await run(plan.redeem)).paid).toBe(true);
  });

  it('too little money: the run pays nobody, the slot stays unpaid, and a later slot still pays', async () => {
    const plan = await register({ recipients: [{ recipient: ALEX, amount: usdc('1000000') }], runs: 2 });
    await chain.rpc('anvil_setStorageAt', [chain.usdc, slotOf(WALLET), `0x${'00'.repeat(32)}`]);
    await chain.setTime(plan.start + 30);
    expect((await run(plan.redeem)).paid).toBe(false);
    expect(await chain.usdcOf(ALEX)).toBe(0n);

    await chain.mintUsdc(WALLET, units('2000000'));
    await chain.setTime(plan.start + plan.interval + 30);
    expect((await run(plan.redeem)).paid).toBe(true);
    expect(await chain.usdcOf(ALEX)).toBe(units('1000000'));
  });

  it('a delegation signed for another chain never pays', async () => {
    const plan = await register({ signChainId: 421614 });
    await chain.setTime(plan.start + 30);
    expect((await run(plan.redeem)).paid).toBe(false);
    expect(await chain.usdcOf(ALEX)).toBe(0n);
  });

  it('the delegation can be read back from the event (never tested in the lab)', async () => {
    const plan = await register();
    const logs = await chain.pub.getContractEvents({ address: executor, abi: EXECUTOR_ABI, eventName: 'Registered' });
    const last = logs.at(-1);
    expect(last.args.intentId).toBe(plan.id);
    expect(delegationFromRedeem(last.args.redeem)?.delegator.toLowerCase()).toBe(WALLET.toLowerCase());
  });
});

function slotOf(owner: Hex): Hex {
  // balanceOf is the first state variable of MockUSDC: keccak256(abi.encode(owner, 0)).
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, 0n]));
}
