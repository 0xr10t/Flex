// One-time payments, from an HTTP request to a balance change on a local chain, through the real service and a real 7702
// account running MetaMask's real DeleGator.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEther, parseUnits, type Hex } from 'viem';
import { autoApprove } from '../../src/approval.js';
import { UPGRADED_CODE } from '../../src/chain/addresses.js';
import { createChainGateway } from '../../src/chain/gateway.js';
import type { WalletConfig } from '../../src/config.js';
import { silentLogger } from '../../src/log.js';
import { Runner } from '../../src/runner/runner.js';
import { createService, type Service } from '../../src/service.js';
import { openDatabase, Store } from '../../src/store/store.js';
import { ARBITRUM, BASE, DB_KEY, envelope, payEth, payUsdc, WALLET } from '../support/envelopes.js';
import { startChain, userAccount, type LocalChain } from './harness.js';

const ALEX: Hex = '0x000000000000000000000000000000000000a11c';
const BOB: Hex = '0x0000000000000000000000000000000000000b0b';
const address = (n: number) => `0x${(0x100000 + n).toString(16).padStart(40, '0')}` as Hex;
const units = (v: string) => parseUnits(v, 6);

let base: LocalChain;
let arbitrum: LocalChain;
let snapshots: Record<string, string>;
let agent: Server;
let reports: Record<string, unknown>[];
let agentUrl: string;
let dir: string;
let service: Service;
let walletUrl: string;

const serviceOn = (dbPath: string): Service => {
  const config: WalletConfig = {
    server: { host: '127.0.0.1', port: 0 as number },
    agent: { url: agentUrl },
    auth: { inbound_token_file: 'unused', report_token_file: 'unused' },
    db: { path: dbPath },
    approval: { mode: 'auto_approve_testnets' },
    chains: [
      { chain_id: BASE, rpc_url: base.rpcUrl },
      { chain_id: ARBITRUM, rpc_url: arbitrum.rpcUrl },
    ],
  };
  return createService(
    config,
    { account: userAccount, dbKeyHex: DB_KEY, inboundToken: 'in', reportToken: 'report' },
    silentLogger,
    { pollMs: 50 },
  );
};

beforeAll(async () => {
  [base, arbitrum] = await Promise.all([startChain(BASE), startChain(ARBITRUM)]);
  await Promise.all([base.mintUsdc(WALLET, units('10000')), arbitrum.mintUsdc(WALLET, units('10000'))]);
  agent = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      reports.push(JSON.parse(data) as Record<string, unknown>);
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((r) => agent.listen(0, '127.0.0.1', r));
  agentUrl = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`;
});

afterAll(async () => {
  base?.stop();
  arbitrum?.stop();
  await new Promise((r) => agent.close(r));
});

beforeEach(async () => {
  snapshots = { base: await base.snapshot(), arbitrum: await arbitrum.snapshot() };
  reports = [];
  dir = mkdtempSync(join(tmpdir(), 'flex-wallet-chain-'));
  service = serviceOn(join(dir, 'wallet.db'));
  walletUrl = await service.start();
});

afterEach(async () => {
  await service.stop();
  rmSync(dir, { recursive: true, force: true });
  await base.revert(snapshots.base as string);
  await arbitrum.revert(snapshots.arbitrum as string);
});

const post = (body: { request_id: string }) =>
  fetch(`${walletUrl}/v1/intents`, {
    method: 'POST',
    headers: { authorization: 'Bearer in', 'idempotency-key': body.request_id, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Sends a request and waits for its report. */
const pay = async (e: ReturnType<typeof envelope>) => {
  const res = await post(e);
  expect(res.status).toBe(202);
  await vi.waitFor(() => expect(reports.filter((r) => r.request_id === e.request_id)).toHaveLength(e.intents.length), {
    timeout: 30_000,
    interval: 50,
  });
  return reports.filter((r) => r.request_id === e.request_id);
};

describe('your examples', () => {
  it('1. send 10 USDC to Alex: paid, the account upgraded on first use, and one recipient still goes as a batch', async () => {
    expect(await base.pub.getCode({ address: WALLET })).toBeUndefined();
    const [report] = await pay(envelope([payUsdc(0, [[ALEX, '10']])]));
    expect(report).toMatchObject({ kind: 'intent_result', status: 'executed' });
    expect(await base.usdcOf(ALEX)).toBe(units('10'));
    expect(((await base.pub.getCode({ address: WALLET })) as string).toLowerCase()).toBe(UPGRADED_CODE);
  });

  it('2. send 10 USDC to Alex on Arbitrum: only that chain changes', async () => {
    const [report] = await pay(envelope([payUsdc(0, [[ALEX, '10']], ARBITRUM)]));
    expect(report).toMatchObject({ status: 'executed' });
    expect(await arbitrum.usdcOf(ALEX)).toBe(units('10'));
    expect(await base.usdcOf(ALEX)).toBe(0n);
    expect(await base.pub.getCode({ address: WALLET })).toBeUndefined();
  });

  it('3. send 10 to Alex and 20 to Bob: both paid in one transaction', async () => {
    const [report] = await pay(
      envelope([
        payUsdc(0, [
          [ALEX, '10'],
          [BOB, '20'],
        ]),
      ]),
    );
    expect(report).toMatchObject({ status: 'executed' });
    expect(await base.usdcOf(ALEX)).toBe(units('10'));
    expect(await base.usdcOf(BOB)).toBe(units('20'));
    expect(await base.usdcOf(WALLET)).toBe(units('9970'));
    const tx = await base.pub.getTransaction({ hash: report?.tx_hash as Hex });
    expect(tx.to?.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(tx.value).toBe(0n);
  });

  it('payroll: 100 people with different amounts, one transaction', async () => {
    const people = Array.from({ length: 100 }, (_, n): [Hex, string] => [address(n), String(n + 1)]);
    const [report] = await pay(envelope([payUsdc(0, people)]));
    expect(report).toMatchObject({ status: 'executed' });
    expect(await base.usdcOf(address(0))).toBe(units('1'));
    expect(await base.usdcOf(address(99))).toBe(units('100'));
    const receipt = await base.pub.getTransactionReceipt({ hash: report?.tx_hash as Hex });
    // B12 measured 3.91 M for 100 USDC transfers. This mock token isn't the same contract, so the margin is wide.
    expect(receipt.gasUsed).toBeLessThan(5_000_000n);
  });
});

describe('other combinations', () => {
  it('ETH to one person, with empty data', async () => {
    const before = await base.ethOf(ALEX);
    const [report] = await pay(envelope([payEth(0, [[ALEX, '0.01']])]));
    expect(report).toMatchObject({ status: 'executed' });
    expect((await base.ethOf(ALEX)) - before).toBe(parseEther('0.01'));
  });

  it('ETH to an organisation: each person gets their own amount, in one transaction', async () => {
    const people: [Hex, string][] = [
      [address(1), '0.01'],
      [address(2), '0.025'],
      [address(3), '0.0003'],
    ];
    const before = await Promise.all(people.map(([a]) => base.ethOf(a)));
    const [report] = await pay(envelope([payEth(0, people)]));
    expect(report).toMatchObject({ status: 'executed' });
    for (const [n, [a, v]] of people.entries()) {
      expect((await base.ethOf(a)) - (before[n] as bigint)).toBe(parseEther(v));
    }
    const receipt = await base.pub.getTransactionReceipt({ hash: report?.tx_hash as Hex });
    expect(receipt.status).toBe('success');
  });

  it('USDC and ETH steps on two chains in one request', async () => {
    const before = await arbitrum.ethOf(BOB);
    const reported = await pay(envelope([payUsdc(0, [[ALEX, '5']]), payEth(1, [[BOB, '0.02']], ARBITRUM)]));
    expect(reported.map((r) => r.status)).toEqual(['executed', 'executed']);
    expect(await base.usdcOf(ALEX)).toBe(units('5'));
    expect((await arbitrum.ethOf(BOB)) - before).toBe(parseEther('0.02'));
  });

  it('the same request sent twice pays once', async () => {
    const e = envelope([payUsdc(0, [[ALEX, '10']])]);
    await post(e);
    await pay(e);
    await post(e);
    await new Promise((r) => setTimeout(r, 300));
    expect(await base.usdcOf(ALEX)).toBe(units('10'));
    expect(reports).toHaveLength(1);
  });

  it('a second request reuses the upgrade', async () => {
    await pay(envelope([payUsdc(0, [[ALEX, '1']])]));
    const nonce = await base.pub.getTransactionCount({ address: WALLET });
    await pay(envelope([payUsdc(0, [[ALEX, '1']])]));
    expect(await base.pub.getTransactionCount({ address: WALLET })).toBe(nonce + 1);
    expect(await base.usdcOf(ALEX)).toBe(units('2'));
  });
});

describe('when it must not pay', () => {
  it('a second recipient that refuses ETH: nobody is paid (B4)', async () => {
    const REFUSES = address(500);
    await base.setCode(REFUSES, '0x60006000fd');
    const before = await base.ethOf(ALEX);
    const [report] = await pay(
      envelope([
        payEth(0, [
          [ALEX, '0.3'],
          [REFUSES, '0.1'],
        ]),
      ]),
    );
    expect(report).toMatchObject({ status: 'failed' });
    expect(await base.ethOf(ALEX)).toBe(before);
  });

  it('not enough USDC: nobody is paid, and no transaction is sent', async () => {
    const [report] = await pay(
      envelope([
        payUsdc(0, [
          [ALEX, '10'],
          [BOB, '20000'],
        ]),
      ]),
    );
    expect(report).toMatchObject({ status: 'failed' });
    expect(report?.tx_hash).toBeUndefined();
    expect(await base.usdcOf(ALEX)).toBe(0n);
  });

  it('a token that says "success" but moves nothing is caught before anything is signed (B1)', async () => {
    await base.setCode(base.usdc, '0x600160005260206000f3');
    const nonce = await base.pub.getTransactionCount({ address: WALLET });
    const e = envelope([payUsdc(0, [[ALEX, '10']])]);
    const [report] = await pay(e);
    expect(report).toMatchObject({ status: 'failed' });
    expect(report?.tx_hash).toBeUndefined();
    expect(service.store.stepsOf(e.request_id)[0]?.error_code).toBe('SIMULATION_MISMATCH');
    expect(await base.pub.getTransactionCount({ address: WALLET })).toBe(nonce);
    expect(await base.pub.getCode({ address: WALLET })).toBeUndefined();
  });

  it('an account delegated to other code is refused, and stays as it was', async () => {
    const other = `0xef0100${'12'.repeat(20)}` as Hex;
    await base.setCode(WALLET, other);
    const [report] = await pay(envelope([payUsdc(0, [[ALEX, '10']])]));
    expect(report).toMatchObject({ status: 'failed' });
    expect(await base.usdcOf(ALEX)).toBe(0n);
    expect(await base.pub.getCode({ address: WALLET })).toBe(other);
  });
});

describe('a crash on a real chain', () => {
  it('after the transaction is sent, before the result is stored: a restart pays nothing twice', async () => {
    const path = join(dir, 'crash.db');
    const db = openDatabase(path, DB_KEY);
    const store = new Store(db);
    const e = envelope([payUsdc(0, [[ALEX, '10']])]);
    store.insertRequest(e, '2026-11-06T10:00:00.000Z');

    const real = createChainGateway(BASE, base.rpcUrl, userAccount);
    let first = true;
    const dies = {
      ...real,
      // The process dies right after the first look: the transaction went out, and its result was never stored.
      getReceipt: async (hash: Hex) => {
        if (first) {
          first = false;
          return null;
        }
        return new Promise<never>(() => {
          void hash;
        });
      },
    };
    void new Runner({
      store,
      walletAddress: WALLET,
      approver: autoApprove,
      gatewayFor: () => dies,
      log: silentLogger,
      onReportQueued: () => {},
      pollMs: 20,
    }).kick();
    await vi.waitFor(async () => expect(await base.usdcOf(ALEX)).toBe(units('10')), { timeout: 20_000, interval: 50 });
    expect(store.stepsOf(e.request_id)[0]?.status).toBe('signed');

    // A new runner on the same store is what a restart does.
    await new Runner({
      store,
      walletAddress: WALLET,
      approver: autoApprove,
      gatewayFor: () => real,
      log: silentLogger,
      onReportQueued: () => {},
      pollMs: 20,
    }).kick();
    expect(store.stepsOf(e.request_id)[0]?.status).toBe('executed');
    expect(await base.usdcOf(ALEX)).toBe(units('10'));
    db.close();
  });
});
