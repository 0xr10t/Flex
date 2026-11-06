// The wallet's main promise, tested the hard way: the service runs in its own process, and is killed with SIGKILL while a
// payment is in flight. It gets no chance to clean up. A new process then starts on the same database.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUnits, type Hex } from 'viem';
import { openDatabase, Store } from '../../src/store/store.js';
import { BASE, DB_KEY, envelope, payUsdc, WALLET } from '../support/envelopes.js';
import { freePort, startChain, type LocalChain } from './harness.js';

const ALEX: Hex = '0x000000000000000000000000000000000000a11c';
const VITE_NODE = new URL('../../node_modules/.bin/vite-node', import.meta.url).pathname;
const SERVE = new URL('./serve.ts', import.meta.url).pathname;
const units = (v: string) => parseUnits(v, 6);

let chain: LocalChain;
let snapshot: string;
let agent: Server;
let reports: Record<string, unknown>[];
let dir: string;
let configPath: string;
let dbPath: string;
let walletUrl: string;
let proc: ChildProcess | null = null;

const startProcess = () =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(VITE_NODE, [SERVE, configPath], { stdio: ['ignore', 'pipe', 'ignore'] });
    proc = child;
    child.on('error', reject);
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('ready')) resolve();
    });
  });

const killProcess = async () => {
  const child = proc;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await gone;
};

/** Reads the database the way the next process will find it. */
const readStep = (requestId: string) => {
  const db = openDatabase(dbPath, DB_KEY);
  try {
    return new Store(db).stepsOf(requestId)[0];
  } finally {
    db.close();
  }
};

const post = (e: { request_id: string }) =>
  fetch(`${walletUrl}/v1/intents`, {
    method: 'POST',
    headers: { authorization: 'Bearer in', 'idempotency-key': e.request_id, 'content-type': 'application/json' },
    body: JSON.stringify(e),
  });

beforeAll(async () => {
  chain = await startChain(BASE);
  await chain.mintUsdc(WALLET, units('1000'));
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
});

afterAll(async () => {
  chain?.stop();
  await new Promise((r) => agent.close(r));
});

beforeEach(async () => {
  snapshot = await chain.snapshot();
  reports = [];
  dir = mkdtempSync(join(tmpdir(), 'flex-wallet-crash-'));
  dbPath = join(dir, 'wallet.db');
  configPath = join(dir, 'config.json');
  const port = await freePort();
  walletUrl = `http://127.0.0.1:${port}`;
  writeFileSync(
    configPath,
    JSON.stringify({
      server: { host: '127.0.0.1', port },
      agent: { url: `http://127.0.0.1:${(agent.address() as AddressInfo).port}` },
      auth: { inbound_token_file: 'unused', report_token_file: 'unused' },
      db: { path: dbPath },
      approval: { mode: 'auto_approve_testnets' },
      chains: [{ chain_id: BASE, rpc_url: chain.rpcUrl }],
    }),
  );
  await startProcess();

  // The first payment does the 7702 upgrade, so the payment under test is one transaction.
  const warmup = envelope([payUsdc(0, [[ALEX, '1']])]);
  await post(warmup);
  await vi.waitFor(() => expect(reports).toHaveLength(1), { timeout: 30_000, interval: 50 });
  reports.length = 0;

  await chain.rpc('evm_setAutomine', [false]);
});

afterEach(async () => {
  await killProcess();
  await chain.rpc('evm_setAutomine', [true]);
  await chain.revert(snapshot);
  rmSync(dir, { recursive: true, force: true });
});

describe('kill -9 while a payment is in flight', () => {
  it('sent, then killed, then mined: the restart finds it, pays nothing more, and reports it', async () => {
    const e = envelope([payUsdc(0, [[ALEX, '10']])]);
    expect((await post(e)).status).toBe(202);
    await vi.waitFor(
      async () => {
        const hash = readStep(e.request_id)?.tx_hash as Hex | null;
        expect(hash && (await chain.rpc('eth_getTransactionByHash', [hash]))).toBeTruthy();
      },
      { timeout: 20_000, interval: 50 },
    );
    expect(await chain.usdcOf(ALEX)).toBe(units('1'));
    const nonceBefore = await chain.pub.getTransactionCount({ address: WALLET });

    await killProcess();
    expect(reports).toHaveLength(0);
    expect(readStep(e.request_id)?.status).toBe('signed');

    await chain.rpc('evm_mine');
    expect(await chain.usdcOf(ALEX)).toBe(units('11'));

    await chain.rpc('evm_setAutomine', [true]);
    await startProcess();
    await vi.waitFor(() => expect(reports).toHaveLength(1), { timeout: 30_000, interval: 50 });

    expect(reports[0]).toMatchObject({ request_id: e.request_id, status: 'executed' });
    expect(await chain.usdcOf(ALEX)).toBe(units('11'));
    expect(await chain.pub.getTransactionCount({ address: WALLET })).toBe(nonceBefore + 1);
  });

  it('sent, then killed, then lost by the network: the restart resends the same transaction, and pays once', async () => {
    const e = envelope([payUsdc(0, [[ALEX, '10']])]);
    await post(e);
    await vi.waitFor(
      async () => {
        const hash = readStep(e.request_id)?.tx_hash as Hex | null;
        expect(hash && (await chain.rpc('eth_getTransactionByHash', [hash]))).toBeTruthy();
      },
      { timeout: 20_000, interval: 50 },
    );
    await killProcess();
    const hash = readStep(e.request_id)?.tx_hash as Hex;

    await chain.rpc('anvil_dropAllTransactions');
    expect(await chain.rpc('eth_getTransactionByHash', [hash])).toBeNull();

    await chain.rpc('evm_setAutomine', [true]);
    await startProcess();
    await vi.waitFor(() => expect(reports).toHaveLength(1), { timeout: 30_000, interval: 50 });

    expect(reports[0]).toMatchObject({ status: 'executed', tx_hash: hash });
    expect(await chain.usdcOf(ALEX)).toBe(units('11'));
  });

  it('a retry from the agent after the restart gets the first answer, and pays nothing more', async () => {
    const e = envelope([payUsdc(0, [[ALEX, '10']])]);
    await post(e);
    await vi.waitFor(() => expect(readStep(e.request_id)?.status).toBe('signed'), { timeout: 20_000, interval: 50 });
    await killProcess();
    await chain.rpc('evm_setAutomine', [true]);
    await chain.rpc('evm_mine');

    await startProcess();
    expect((await post(e)).status).toBe(202);
    await vi.waitFor(() => expect(reports).toHaveLength(1), { timeout: 30_000, interval: 50 });
    expect(await chain.usdcOf(ALEX)).toBe(units('11'));
  });
});
