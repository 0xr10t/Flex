// Wires the wallet together. `main.ts` starts it for real; the end-to-end tests start it with a test key.

import { getSmartAccountsEnvironment, type SmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import type { FastifyInstance } from 'fastify';
import type { LocalAccount } from 'viem';
import { autoApprove, rejectAll, type Approver } from './approval.js';
import { createChainGateway, type ChainGateway } from './chain/gateway.js';
import type { WalletConfig } from './config.js';
import type { Logger } from './log.js';
import { RunWatcher } from './autopay/watcher.js';
import type { Deployment } from './runner/handler.js';
import { ReportSender } from './runner/reports.js';
import { Runner } from './runner/runner.js';
import { buildApp } from './server/app.js';
import { openDatabase, Store } from './store/store.js';

export interface ServiceSecrets {
  account: LocalAccount;
  dbKeyHex: string;
  inboundToken: string;
  reportToken: string;
}

export interface Service {
  app: FastifyInstance;
  store: Store;
  runner: Runner;
  reports: ReportSender;
  watcher: RunWatcher;
  /** Starts listening, and continues whatever was unfinished when the service last stopped. */
  start(): Promise<string>;
  stop(): Promise<void>;
}

export function approverFor(mode: WalletConfig['approval']['mode']): Approver {
  return mode === 'auto_approve_testnets' ? autoApprove : rejectAll;
}

export function createService(
  config: WalletConfig,
  secrets: ServiceSecrets,
  log: Logger,
  overrides: {
    pollMs?: number;
    watchMs?: number;
    bridgeTimeoutMs?: number;
    /** A local test chain has MetaMask's contracts at its own addresses. */
    envFor?: (chainId: number) => SmartAccountsEnvironment;
  } = {},
): Service {
  const db = openDatabase(config.db.path, secrets.dbKeyHex);
  const store = new Store(db);
  const gateways = new Map<number, ChainGateway>(
    config.chains.map((c) => [c.chain_id, createChainGateway(c.chain_id, c.rpc_url, secrets.account, c.simulation)]),
  );
  const envFor = overrides.envFor ?? ((chainId: number) => getSmartAccountsEnvironment(chainId));
  const deployments = new Map<number, Deployment>(
    config.chains.flatMap((c) =>
      c.executor
        ? [
            [
              c.chain_id,
              {
                executor: c.executor.address,
                deploymentBlock: c.executor.deployment_block,
                env: envFor(c.chain_id),
              },
            ] as [number, Deployment],
          ]
        : [],
    ),
  );
  const reports = new ReportSender({ store, agentUrl: config.agent.url, reportToken: secrets.reportToken, log });
  const runner = new Runner({
    store,
    walletAddress: secrets.account.address,
    approver: approverFor(config.approval.mode),
    gatewayFor: (chainId) => {
      const gateway = gateways.get(chainId);
      if (!gateway) throw new Error('chain not configured');
      return gateway;
    },
    deploymentFor: (chainId) => deployments.get(chainId) ?? null,
    log,
    onReportQueued: () => void reports.kick(),
    ...(overrides.pollMs === undefined ? {} : { pollMs: overrides.pollMs }),
    ...(overrides.bridgeTimeoutMs === undefined ? {} : { bridgeTimeoutMs: overrides.bridgeTimeoutMs }),
  });
  const watcher = new RunWatcher({
    store,
    chains: [...deployments].map(([chainId, d]) => ({
      chainId,
      executor: d.executor,
      gateway: gateways.get(chainId) as ChainGateway,
    })),
    log,
    onReportQueued: () => void reports.kick(),
    ...(overrides.watchMs === undefined ? {} : { intervalMs: overrides.watchMs }),
  });
  const app = buildApp({
    store,
    walletAddress: secrets.account.address,
    inboundToken: secrets.inboundToken,
    chainIds: config.chains.map((c) => c.chain_id),
    executorChainIds: [...deployments.keys()],
    onAccepted: () => void runner.kick(),
    log,
  });
  return {
    app,
    store,
    runner,
    reports,
    watcher,
    start: async () => {
      const address = await app.listen({ host: config.server.host, port: config.server.port });
      void runner.kick();
      void reports.kick();
      watcher.start();
      return address;
    },
    stop: async () => {
      await app.close();
      await runner.stop();
      await watcher.stop();
      await reports.stop();
      db.close();
    },
  };
}
