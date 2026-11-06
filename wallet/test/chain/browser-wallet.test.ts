// Exercises the browser handoff with a test-only wallet on local Anvil chains. This does not claim real MetaMask or CCIP delivery.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseAbi, parseEther, type Hex } from 'viem';
import { CCIP } from '../../src/schemas/bridge.v2.js';
import type { WalletBatchPayload } from '../../src/browser/types.js';
import { ALEX, WALLET, envelope, payEth } from '../support/envelopes.js';
import { userAccount } from './harness.js';
import { startWorld, units, type World, type Wallet } from './world.js';

let world: World;
const HOST = '127.0.0.1:8788';
const ROUTER = parseAbi([
  'function setFee(uint256 value)',
  'function deliver(uint64 source, uint64 number, bytes32 id, address token, address receiver, uint256 amount, bool success)',
]);
beforeAll(async () => {
  world = await startWorld();
});
afterAll(() => world.stop());
beforeEach(async () => {
  await world.snapshot();
  const hash = await world.arbitrum.deployer.sendTransaction({
    to: world.routerOf(world.arbitrum),
    data: encodeFunctionData({ abi: ROUTER, functionName: 'setFee', args: [parseEther('0.001')] }),
  });
  await world.arbitrum.pub.waitForTransactionReceipt({ hash });
});
afterEach(() => world.reset());

async function session(wallet: Wallet) {
  const page = await wallet.service.app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
  expect(page.statusCode).toBe(200);
  const headers = {
    host: HOST,
    origin: `http://${HOST}`,
    'x-flex-wallet': '1',
    cookie: String(page.headers['set-cookie']).split(';')[0]!,
  };
  return (action: string, payload: object) =>
    wallet.service.app.inject({
      method: 'POST',
      url: `/browser/${action}`,
      headers,
      payload,
    });
}

describe('browser approved CCIP transfer', () => {
  it('keeps a single-recipient payment inside its checked batch when the browser sends one call directly', async () => {
    await world.upgrade(world.base, userAccount);
    const wallet = await world.startWallet({ approval: 'metamask' });
    const post = await session(wallet);
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    expect((await wallet.post(e)).status).toBe(202);
    await vi.waitFor(() => expect(wallet.service.store.walletBatch(e.request_id, 0)).not.toBeNull(), {
      timeout: 15000,
    });
    const batch = wallet.service.store.walletBatch(e.request_id, 0)!;
    const payload = JSON.parse(batch.payload_json) as WalletBatchPayload;
    expect(payload.calls.calls).toHaveLength(1);
    const call = payload.calls.calls[0]!;
    expect(call.to.toLowerCase()).toBe(WALLET.toLowerCase());
    expect((await post('claim', { id: batch.batch_id })).statusCode).toBe(200);
    const before = await world.base.ethOf(ALEX);
    const hash = await world.base
      .walletFor(userAccount)
      .sendTransaction({ to: call.to, data: call.data, value: BigInt(call.value) });
    await world.base.pub.waitForTransactionReceipt({ hash });
    expect((await post('recover', { id: batch.batch_id, hash })).statusCode).toBe(200);
    await world.base.rpc('anvil_mine', ['0x80']);
    await vi.waitFor(() => expect(wallet.service.store.step(e.request_id, 0).status).toBe('executed'), {
      timeout: 15000,
    });
    expect(await world.base.ethOf(ALEX)).toBe(before + parseEther('0.01'));
  });
  it('checks a typed transfer, waits for external approval, recovers after restart, and confirms exact finalized delivery', async () => {
    let wallet = await world.startWallet({ approval: 'metamask', dbName: 'browser.db' });
    let post = await session(wallet);
    const prepared = await post('bridge', { sourceChainId: 421614, destChainId: 84532, amount: '1.00' });
    expect(prepared.statusCode).toBe(200);
    const id = prepared.json<{ requestId: string }>().requestId;
    await vi.waitFor(() => expect(wallet.service.store.walletBatch(id, 0)).not.toBeNull(), { timeout: 15000 });
    const batch = wallet.service.store.walletBatch(id, 0)!;
    const payload = JSON.parse(batch.payload_json) as WalletBatchPayload;
    const before = await world.arbitrum.pub.getTransactionCount({ address: WALLET });
    expect((await post('claim', { id: batch.batch_id })).json().calls).toMatchObject({
      atomicRequired: true,
      id: batch.batch_id,
    });
    expect(await world.arbitrum.pub.getTransactionCount({ address: WALLET })).toBe(before);
    expect((await post('claim', { id: batch.batch_id })).statusCode).toBe(409);
    expect((await post('wallet-id', { id: batch.batch_id, walletId: '0xabcdef123456' })).statusCode).toBe(200);

    // Acts only as the external approving wallet on this isolated local chain. The service has no signing key.
    await world.upgrade(world.arbitrum, userAccount);
    const hash = await world.arbitrum.walletFor(userAccount).sendTransaction({
      to: payload.expectedTx.to,
      data: payload.expectedTx.data,
      value: 0n,
    });
    await world.arbitrum.pub.waitForTransactionReceipt({ hash });
    await wallet.stop();
    wallet = await world.startWallet({ approval: 'metamask', dbName: 'browser.db' });
    post = await session(wallet);
    expect(wallet.service.store.walletBatch(id, 0)?.batch_id).toBe(batch.batch_id);
    expect(JSON.parse(wallet.service.store.walletBatch(id, 0)!.payload_json).providerBatchId).toBe('0xabcdef123456');
    const result = await post('recover', { id: batch.batch_id, hash });
    expect(result.statusCode, result.body).toBe(200);
    await vi.waitFor(() => expect(wallet.service.store.step(id, 0).status).toBe('waiting'), { timeout: 15000 });
    const message = wallet.service.store.stepData<{ message: { message_id: Hex; message_number: string } }>(
      id,
      0,
    )!.message;
    const delivered = await world.base.deployer.sendTransaction({
      to: world.routerOf(world.base),
      data: encodeFunctionData({
        abi: ROUTER,
        functionName: 'deliver',
        args: [
          CCIP[421614].selector,
          BigInt(message.message_number),
          message.message_id,
          world.base.usdc,
          WALLET,
          units('1'),
          true,
        ],
      }),
    });
    await world.base.pub.waitForTransactionReceipt({ hash: delivered });
    expect(wallet.service.store.step(id, 0).status).toBe('waiting');
    await world.arbitrum.rpc('anvil_mine', ['0x80']);
    await world.base.rpc('anvil_mine', ['0x80']);
    await vi.waitFor(() => expect(wallet.service.store.step(id, 0).status).toBe('executed'), { timeout: 15000 });
    expect(await world.arbitrum.usdcOf(world.routerOf(world.arbitrum))).toBe(units('1'));
    // The separate 7702 upgrade consumes both a transaction nonce and an authorization nonce, then one batch.
    expect(await world.arbitrum.pub.getTransactionCount({ address: WALLET })).toBe(before + 3);
    expect(world.reports.filter((r) => r.request_id === id)).toHaveLength(1);
  });
});
