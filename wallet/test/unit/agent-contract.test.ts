// The agent's real code on the other end of the wallet's real service (Part 2's exit criterion). The agent still sends
// envelope v1, so these send v2 envelopes through its client, and check what happens on the wire.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { WalletConfig } from '../../src/config.js';
import { silentLogger } from '../../src/log.js';
import { createService, type Service } from '../../src/service.js';
import { ALEX, BASE, DB_KEY, envelope, payEth, WALLET } from '../support/envelopes.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A public Anvil test key. The agent's modules are outside this package's root, hence the paths built at runtime.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const AGENT = '../../../src';
const load = async (path: string) => (await import(/* @vite-ignore */ `${AGENT}/${path}`)) as Record<string, never>;

let dir: string;
let service: Service;
let url: string;
let agentServer: Server;
let reports: unknown[];
let validateReport: (body: unknown) => boolean;
let createExecutionClient: (
  config: unknown,
  token: string,
) => {
  submit: (body: unknown, key: string) => Promise<{ status: string; message?: string; cause?: string }>;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'flex-wallet-'));
  reports = [];
  ({ validateReport } = (await load('server/bodies.ts')) as never);
  ({ createExecutionClient } = (await load('handoff/execution-client.ts')) as never);

  agentServer = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      reports.push(JSON.parse(data));
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((r) => agentServer.listen(0, '127.0.0.1', r));

  const config: WalletConfig = {
    server: { host: '127.0.0.1', port: 0 as number },
    agent: { url: `http://127.0.0.1:${(agentServer.address() as AddressInfo).port}` },
    auth: { inbound_token_file: 'unused', report_token_file: 'unused' },
    db: { path: join(dir, 'wallet.db') },
    approval: { mode: 'reject_all' },
    network: { socks_proxy: null },
    chains: [{ chain_id: BASE, rpc_url: 'http://127.0.0.1:9' }],
  };
  service = createService(
    config,
    {
      account: privateKeyToAccount(TEST_KEY),
      dbKeyHex: DB_KEY,
      inboundToken: 'in-token',
      reportToken: 'report-token',
    },
    silentLogger,
    { pollMs: 1 },
  );
  url = await service.start();
});

afterEach(async () => {
  await service.stop();
  await new Promise((r) => agentServer.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const client = (token = 'in-token') => createExecutionClient({ execution: { url, timeout_ms: 5000 } }, token);

describe("the agent's execution client against the wallet", () => {
  it('a good envelope is accepted (A-51)', async () => {
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    expect(await client().submit(e, e.request_id)).toEqual({ status: 'accepted' });
  });

  it('a repeat with the same key is accepted too, as the agent expects when it retries', async () => {
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    await client().submit(e, e.request_id);
    expect(await client().submit(e, e.request_id)).toEqual({ status: 'accepted' });
    expect(service.store.stepsOf(e.request_id)).toHaveLength(1);
  });

  it('a refused envelope gives the wallet message the agent shows the user (A-52)', async () => {
    const e = { ...envelope([payEth(0, [[ALEX, '0.01']])]), wallet_address: ALEX };
    expect(await client().submit(e, e.request_id)).toEqual({
      status: 'rejected',
      message: 'this request is for a different wallet.',
    });
  });

  it('the v1 envelope the agent sends today is refused', async () => {
    const v1 = {
      version: '1',
      request_id: 'req_0123456789ab',
      wallet_address: WALLET,
      created_at: '2026-11-06T10:00:00Z',
      intents: [],
    };
    expect((await client().submit(v1, v1.request_id)).status).toBe('rejected');
  });

  it('a wallet that is down gives the "unavailable" result', async () => {
    await service.app.close();
    expect((await client().submit({}, 'k')).status).toBe('unavailable');
  });
});

describe('the report the wallet sends', () => {
  it("passes the agent's own report check", async () => {
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    await client().submit(e, e.request_id);
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(validateReport(reports[0])).toBe(true);
    expect(reports[0]).toMatchObject({ kind: 'intent_result', request_id: e.request_id, status: 'failed' });
  });

  it('an executed report has the fields the agent requires', async () => {
    const report = {
      kind: 'intent_result',
      request_id: 'req_0123456789ab',
      step: 0,
      status: 'executed',
      tx_hash: `0x${'ab'.repeat(32)}`,
      executed_at: '2026-11-06T10:00:05.000Z',
    };
    expect(validateReport(report)).toBe(true);
  });
});
