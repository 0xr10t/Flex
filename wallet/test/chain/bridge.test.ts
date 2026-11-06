// Bridges with a stand-in router at the real router address. It enforces the send rules found in the lab, but delivers nothing:
// the test mints on the destination to play the network. So this proves the wallet's behaviour, not real CCIP delivery.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, erc20Abi, parseAbi, parseEther, type Hex } from 'viem';
import { WALLET, bridge, envelope, payUsdc } from '../support/envelopes.js';
import { startWorld, units, type World } from './world.js';
import { CCIP } from '@flex/protocol/schemas/bridge.v2';

const ALEX: Hex = '0x000000000000000000000000000000000000a11c';
const ROUTER_ADMIN = parseAbi([
  'function setFee(uint256 value)',
  'function setLaneClosed(bool value)',
  'function deliver(uint64 source, uint64 number, bytes32 id, address token, address receiver, uint256 amount, bool success)',
]);
const FEE = parseEther('0.0011');

let world: World;
beforeAll(async () => {
  world = await startWorld();
});
afterAll(() => world.stop());
beforeEach(async () => {
  await world.snapshot();
  await setFee(FEE);
});
afterEach(() => world.reset());

const adminCall = async (data: Hex) => {
  const hash = await world.arbitrum.deployer.sendTransaction({ to: world.routerOf(world.arbitrum), data });
  await world.arbitrum.pub.waitForTransactionReceipt({ hash });
};
const setFee = (value: bigint) =>
  adminCall(encodeFunctionData({ abi: ROUTER_ADMIN, functionName: 'setFee', args: [value] }));
const closeLane = () =>
  adminCall(encodeFunctionData({ abi: ROUTER_ADMIN, functionName: 'setLaneClosed', args: [true] }));

const plan = () => envelope([bridge(0, '10', [1]), payUsdc(1, [[ALEX, '40']], 84532, [0])]);
const reportsFor = (id: string) => world.reports.filter((r) => r.request_id === id);
const allowance = () =>
  world.arbitrum.pub.readContract({
    address: world.arbitrum.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [WALLET, world.routerOf(world.arbitrum)],
  });
const waitForSent = (wallet: Awaited<ReturnType<World['startWallet']>>, id: string) =>
  vi.waitFor(() => expect(wallet.service.store.stepsOf(id)[0]?.status).toBe('waiting'), {
    timeout: 15_000,
    interval: 40,
  });

type MessageIdentity = { message_id: Hex; message_number: string };
const messageOf = (wallet: Awaited<ReturnType<World['startWallet']>>, id: string) =>
  wallet.service.store.stepData<{ message: MessageIdentity }>(id, 0)!.message;

async function deliver(
  wallet: Awaited<ReturnType<World['startWallet']>>,
  id: string,
  success = true,
  message: MessageIdentity = messageOf(wallet, id),
  finalize = true,
) {
  const hash = await world.base.deployer.sendTransaction({
    to: world.routerOf(world.base),
    data: encodeFunctionData({
      abi: ROUTER_ADMIN,
      functionName: 'deliver',
      args: [
        CCIP[421614].selector,
        BigInt(message.message_number),
        message.message_id,
        world.base.usdc,
        WALLET,
        units('10'),
        success,
      ],
    }),
  });
  await world.base.pub.waitForTransactionReceipt({ hash });
  // Anvil's finalized tag trails its head. Exercise the production finality path, not an override.
  if (finalize) {
    await world.arbitrum.rpc('anvil_mine', ['0x80']);
    await world.base.rpc('anvil_mine', ['0x80']);
  }
}

describe('a bridge, then a payment that needs it (j, i)', () => {
  it('pays the exact fee, leaves no allowance, and holds the payment until the money arrives', async () => {
    const wallet = await world.startWallet();
    const e = plan();
    expect((await wallet.post(e)).status).toBe(202);
    await waitForSent(wallet, e.request_id);

    expect(await world.arbitrum.ethOf(world.routerOf(world.arbitrum))).toBe(FEE);
    expect(await world.arbitrum.usdcOf(world.routerOf(world.arbitrum))).toBe(units('10'));
    expect(await allowance()).toBe(0n);

    await new Promise((r) => setTimeout(r, 200));
    expect(await world.base.usdcOf(ALEX)).toBe(0n);
    expect(reportsFor(e.request_id)).toHaveLength(0);

    await deliver(wallet, e.request_id);
    await vi.waitFor(() => expect(reportsFor(e.request_id)).toHaveLength(2), { timeout: 15_000, interval: 40 });
    expect(reportsFor(e.request_id)[0]).toMatchObject({ step: 0, status: 'executed', bridge_fee_eth: '0.0011' });
    expect(reportsFor(e.request_id)[0]?.tx_hash).toMatch(/^0x/);
    expect(reportsFor(e.request_id)[1]).toMatchObject({ step: 1, status: 'executed' });
    expect(await world.base.usdcOf(ALEX)).toBe(units('40'));
  });

  it('an unrelated transfer of the exact same amount does not count as arrival', async () => {
    const wallet = await world.startWallet();
    const e = plan();
    await wallet.post(e);
    await waitForSent(wallet, e.request_id);
    await world.base.mintUsdc(WALLET, units('10'));
    await world.arbitrum.rpc('anvil_mine', ['0x80']);
    await world.base.rpc('anvil_mine', ['0x80']);
    await new Promise((r) => setTimeout(r, 200));
    expect(reportsFor(e.request_id)).toHaveLength(0);
    expect(await world.base.usdcOf(ALEX)).toBe(0n);
  });

  it('a restart during the wait sends no second bridge, and the wait resumes', async () => {
    let wallet = await world.startWallet({ dbName: 'kept.db' });
    const e = plan();
    await wallet.post(e);
    await waitForSent(wallet, e.request_id);
    const message = messageOf(wallet, e.request_id);
    await wallet.stop();
    await deliver(wallet, e.request_id, true, message);

    wallet = await world.startWallet({ dbName: 'kept.db' });
    await vi.waitFor(() => expect(reportsFor(e.request_id)).toHaveLength(2), { timeout: 15_000, interval: 40 });
    expect(await world.arbitrum.usdcOf(world.routerOf(world.arbitrum))).toBe(units('10'));
    expect(await world.base.usdcOf(ALEX)).toBe(units('40'));
  });

  it('requires finality even after the exact destination message has executed', async () => {
    const wallet = await world.startWallet();
    const e = plan();
    await wallet.post(e);
    await waitForSent(wallet, e.request_id);
    await deliver(wallet, e.request_id, true, messageOf(wallet, e.request_id), false);
    await new Promise((r) => setTimeout(r, 200));
    expect(reportsFor(e.request_id)).toHaveLength(0);
    await world.arbitrum.rpc('anvil_mine', ['0x80']);
    await vi.waitFor(
      () =>
        expect(wallet.service.store.stepData<{ tracking_status: string }>(e.request_id, 0)?.tracking_status).toBe(
          'destination_unfinalized',
        ),
      { timeout: 15000 },
    );
    expect(reportsFor(e.request_id)).toHaveLength(0);
    expect(await world.base.usdcOf(ALEX)).toBe(0n);
    await world.base.rpc('anvil_mine', ['0x80']);
    await vi.waitFor(() => expect(reportsFor(e.request_id)).toHaveLength(2), { timeout: 15_000, interval: 40 });
  });

  it('ignores an executed message with another ID even when it delivers the same amount', async () => {
    const wallet = await world.startWallet();
    const e = plan();
    await wallet.post(e);
    await waitForSent(wallet, e.request_id);
    await deliver(wallet, e.request_id, true, {
      ...messageOf(wallet, e.request_id),
      message_id: `0x${'aa'.repeat(32)}`,
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(reportsFor(e.request_id)).toHaveLength(0);
    expect(wallet.service.store.stepsOf(e.request_id).map((s) => s.status)).toEqual(['waiting', 'pending']);
  });

  it('withdraws a provisional delivery after a destination reorg without paying or resending', async () => {
    const wallet = await world.startWallet();
    const e = plan();
    await wallet.post(e);
    await waitForSent(wallet, e.request_id);
    await world.arbitrum.rpc('anvil_mine', ['0x80']);
    const beforeDelivery = await world.base.snapshot();
    await deliver(wallet, e.request_id, true, messageOf(wallet, e.request_id), false);
    const tracking = () =>
      wallet.service.store.stepData<{ tracking_status: string; observed_destination_tx_hash?: Hex }>(e.request_id, 0);
    await vi.waitFor(() => expect(tracking()?.tracking_status).toBe('destination_unfinalized'), { timeout: 15000 });
    await world.base.revert(beforeDelivery);
    await vi.waitFor(() => expect(tracking()?.tracking_status).toBe('in_transit'), { timeout: 15000 });
    expect(tracking()?.observed_destination_tx_hash).toBeUndefined();
    expect(reportsFor(e.request_id)).toHaveLength(0);
    expect(await world.base.usdcOf(ALEX)).toBe(0n);
    expect(await world.arbitrum.usdcOf(world.routerOf(world.arbitrum))).toBe(units('10'));
  });
});

describe('when a bridge must not go ahead', () => {
  it('a quote above the cap signs nothing, and the payment never starts (rule 4)', async () => {
    await setFee(parseEther('0.003'));
    const wallet = await world.startWallet();
    const e = plan();
    const nonce = await world.arbitrum.pub.getTransactionCount({ address: WALLET });
    await wallet.post(e);
    await vi.waitFor(() => expect(reportsFor(e.request_id)).toHaveLength(2), { timeout: 15_000 });
    expect(reportsFor(e.request_id).map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(wallet.service.store.stepsOf(e.request_id).map((s) => s.error_code)).toEqual([
      'FEE_TOO_HIGH',
      'DEPENDENCY_FAILED',
    ]);
    expect(await world.arbitrum.pub.getTransactionCount({ address: WALLET })).toBe(nonce);
    expect(await world.arbitrum.usdcOf(world.routerOf(world.arbitrum))).toBe(0n);
  });

  it('a closed lane fails the step, and moves nothing', async () => {
    await closeLane();
    const wallet = await world.startWallet();
    const e = plan();
    await wallet.post(e);
    await vi.waitFor(() => expect(reportsFor(e.request_id)).toHaveLength(2), { timeout: 15_000 });
    expect(reportsFor(e.request_id)[0]).toMatchObject({ status: 'failed' });
    expect(await world.arbitrum.usdcOf(WALLET)).toBe(units('100000'));
  });

  it('a delayed bridge stays pending and lets an unrelated payment proceed', async () => {
    const wallet = await world.startWallet({ bridgeTimeoutMs: 200 });
    const e = plan();
    await wallet.post(e);
    await waitForSent(wallet, e.request_id);
    await vi.waitFor(
      () => expect(wallet.service.store.stepData<{ delayed?: boolean }>(e.request_id, 0)?.delayed).toBe(true),
      { timeout: 15_000, interval: 40 },
    );
    expect(wallet.service.store.stepsOf(e.request_id).map((s) => s.status)).toEqual(['waiting', 'pending']);
    expect(reportsFor(e.request_id)).toHaveLength(0);
    const other = envelope([payUsdc(0, [[ALEX, '1']], 84532)]);
    await wallet.post(other);
    await vi.waitFor(() => expect(reportsFor(other.request_id)).toHaveLength(1), { timeout: 15_000, interval: 40 });
    expect(reportsFor(other.request_id)[0]).toMatchObject({ status: 'executed' });
    expect(await world.base.usdcOf(ALEX)).toBe(units('1'));
    await deliver(wallet, e.request_id);
    await vi.waitFor(() => expect(reportsFor(e.request_id)).toHaveLength(2), { timeout: 15_000, interval: 40 });
    expect(reportsFor(e.request_id).map((r) => r.status)).toEqual(['executed', 'executed']);
    expect(await world.arbitrum.usdcOf(world.routerOf(world.arbitrum))).toBe(units('10'));
  });

  it('keeps a failed destination execution recoverable without resending the source transfer', async () => {
    const wallet = await world.startWallet();
    const e = plan();
    await wallet.post(e);
    await waitForSent(wallet, e.request_id);
    await deliver(wallet, e.request_id, false);
    await vi.waitFor(
      () =>
        expect(wallet.service.store.stepData<{ tracking_status: string }>(e.request_id, 0)?.tracking_status).toBe(
          'destination_failed',
        ),
      { timeout: 15_000, interval: 40 },
    );
    expect(reportsFor(e.request_id)).toHaveLength(0);
    await deliver(wallet, e.request_id);
    await vi.waitFor(() => expect(reportsFor(e.request_id)).toHaveLength(2), { timeout: 15_000, interval: 40 });
    expect(await world.arbitrum.usdcOf(world.routerOf(world.arbitrum))).toBe(units('10'));
  });
});
