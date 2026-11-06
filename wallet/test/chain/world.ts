// A full local setup for autopay and bridge tests: two chains, an executor and a stand-in CRE forwarder on each, a stand-in
// CCIP router at the real router addresses, and a stand-in agent that records reports.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, parseEventLogs, parseUnits, type Hex } from 'viem';
import { EXECUTOR_ABI } from '../../src/autopay/abi.js';
import { EIP7702_DELEGATOR } from '../../src/chain/addresses.js';
import type { WalletConfig } from '../../src/config.js';
import { silentLogger } from '../../src/log.js';
import { CCIP } from '../../src/schemas/bridge.v2.js';
import type { HandoffEnvelope } from '../../src/schemas/envelope.js';
import { createService, type Service } from '../../src/service.js';
import { ARBITRUM, BASE, DB_KEY, WALLET } from '../support/envelopes.js';
import { artifact, startChain, userAccount, type LocalChain } from './harness.js';

export interface World {
  base: LocalChain;
  arbitrum: LocalChain;
  executorOf: (chain: LocalChain) => Hex;
  routerOf: (chain: LocalChain) => Hex;
  reports: Record<string, any>[];
  agentStatus: { code: number };
  dir: string;
  startWallet: (options?: {
    dbName?: string;
    bridgeTimeoutMs?: number;
    approval?: WalletConfig['approval']['mode'];
  }) => Promise<Wallet>;
  deliver: (chain: LocalChain, redeem: Hex) => Promise<{ paid: boolean }>;
  upgrade: (chain: LocalChain, account: any) => Promise<void>;
  reset: () => Promise<void>;
  snapshot: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface Wallet {
  service: Service;
  post: (e: HandoffEnvelope) => Promise<Response>;
  stop: () => Promise<void>;
}

export const units = (v: string) => parseUnits(v, 6);

export async function startWorld(): Promise<World> {
  const [base, arbitrum] = await Promise.all([startChain(BASE), startChain(ARBITRUM)]);
  const deployments = new Map<LocalChain, { executor: Hex; forwarder: Hex; block: number; router: Hex }>();
  for (const chain of [base, arbitrum]) {
    const forwarder = await chain.deploy('TestHelpers.sol', 'MockForwarder');
    const executor = await chain.deploy('IntentExecutorV3.sol', 'IntentExecutorV3', [
      forwarder,
      chain.env.DelegationManager,
    ]);
    const router = CCIP[chain.chainId].router;
    await chain.setCode(router, artifact('TestHelpers.sol', 'MockCcipRouter').deployedBytecode.object);
    deployments.set(chain, { executor, forwarder, router, block: Number(await chain.pub.getBlockNumber()) });
    await chain.mintUsdc(WALLET, units('100000'));
  }

  const reports: Record<string, any>[] = [];
  const agentStatus = { code: 204 };
  const agent: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (agentStatus.code === 204) reports.push(JSON.parse(data) as Record<string, any>);
      res.statusCode = agentStatus.code;
      res.end();
    });
  });
  await new Promise<void>((r) => agent.listen(0, '127.0.0.1', r));
  const agentUrl = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`;

  let dir = mkdtempSync(join(tmpdir(), 'flex-wallet-world-'));
  let snapshots: [LocalChain, string][] = [];
  const running = new Set<Wallet>();
  let dbCount = 0;

  const world: World = {
    base,
    arbitrum,
    executorOf: (chain) => (deployments.get(chain) as { executor: Hex }).executor,
    routerOf: (chain) => (deployments.get(chain) as { router: Hex }).router,
    reports,
    agentStatus,
    get dir() {
      return dir;
    },
    startWallet: async (options = {}) => {
      const config: WalletConfig = {
        server: { host: '127.0.0.1', port: 0 as number },
        agent: { url: agentUrl },
        auth: { inbound_token_file: 'unused', report_token_file: 'unused' },
        db: { path: join(dir, options.dbName ?? `wallet-${++dbCount}.db`) },
        approval: { mode: options.approval ?? 'auto_approve_testnets' },
        chains: [base, arbitrum].map((chain) => {
          const d = deployments.get(chain) as { executor: Hex; block: number };
          return {
            chain_id: chain.chainId as 84532,
            rpc_url: chain.rpcUrl,
            executor: { address: d.executor, deployment_block: d.block },
          };
        }),
      };
      const service = createService(
        config,
        { account: userAccount, dbKeyHex: DB_KEY, inboundToken: 'in', reportToken: 'report' },
        silentLogger,
        {
          pollMs: 40,
          watchMs: 80,
          ...(options.bridgeTimeoutMs === undefined ? {} : { bridgeTimeoutMs: options.bridgeTimeoutMs }),
          envFor: (chainId) => (chainId === BASE ? base.env : arbitrum.env),
        },
      );
      const url = await service.start();
      const wallet: Wallet = {
        service,
        post: (e) =>
          fetch(`${url}/v1/intents`, {
            method: 'POST',
            headers: {
              authorization: 'Bearer in',
              'idempotency-key': e.request_id,
              'content-type': 'application/json',
            },
            body: JSON.stringify(e),
          }),
        stop: async () => {
          if (running.delete(wallet)) await service.stop();
        },
      };
      running.add(wallet);
      return wallet;
    },
    deliver: async (chain, redeem) => {
      const d = deployments.get(chain) as { executor: Hex; forwarder: Hex };
      try {
        const hash = await chain.deployer.writeContract({
          address: d.forwarder,
          abi: artifact('TestHelpers.sol', 'MockForwarder').abi,
          functionName: 'deliver',
          args: [
            d.executor,
            `0x${'11'.repeat(32)}`,
            `0x${'00'.repeat(10)}`,
            WALLET,
            encodeAbiParameters([{ type: 'bytes' }], [redeem]),
          ],
          gas: 9_000_000n,
        });
        const receipt = await chain.pub.waitForTransactionReceipt({ hash });
        return { paid: parseEventLogs({ abi: EXECUTOR_ABI, logs: receipt.logs, eventName: 'Executed' }).length === 1 };
      } catch {
        return { paid: false };
      }
    },
    upgrade: async (chain, account) => {
      const nonce = await chain.pub.getTransactionCount({ address: account.address });
      const authorization = await account.signAuthorization({
        address: EIP7702_DELEGATOR,
        chainId: chain.chainId,
        nonce: nonce + 1,
      });
      const hash = await chain
        .walletFor(account)
        .sendTransaction({ authorizationList: [authorization], to: account.address, data: '0x' });
      await chain.pub.waitForTransactionReceipt({ hash });
    },
    snapshot: async () => {
      snapshots = [
        [base, await base.snapshot()],
        [arbitrum, await arbitrum.snapshot()],
      ];
    },
    reset: async () => {
      await Promise.all([...running].map((w) => w.stop()));
      reports.length = 0;
      agentStatus.code = 204;
      for (const [chain, id] of snapshots) await chain.revert(id);
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'flex-wallet-world-'));
    },
    stop: async () => {
      await Promise.all([...running].map((w) => w.stop()));
      base.stop();
      arbitrum.stop();
      rmSync(dir, { recursive: true, force: true });
      await new Promise((r) => agent.close(r));
    },
  };
  return world;
}
