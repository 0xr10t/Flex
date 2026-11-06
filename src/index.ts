// Implements: §21 startup entry (config, token files, keychain key, DB open + migrate, DB5 defaults, Ollama check,
// server bound to 127.0.0.1), §6.1, §6.3, §7, §14.4 startup model check, §16.4, §18 logger.
// Owner: Lane A. The other lanes' factories are injected through `LaneFactories`; the Orchestrator wires the real
// ones (and the step registry) in Phase 2.

import type { FastifyInstance } from 'fastify';
import type {
  AllowlistLogger,
  ContentFetcher,
  EnsClient,
  ExecutionClient,
  RpcClients,
  SubnameSource,
} from './contracts/io.js';
import type { LlmClient } from './contracts/llm.js';
import type { Repos } from './contracts/repos.js';
import type { Config } from './contracts/types.js';
import { chainNames, configPath, expandHome, loadConfig } from './config/load.js';
import { loadTokens } from './config/tokens.js';
import type { Database } from './db/database.js';
import { createOsKeyStore, getOrCreateDbKey, type KeyStore } from './db/keychain.js';
import { openDatabase } from './db/open.js';
import { createRepos } from './db/repos/index.js';
import { createApp } from './server/app.js';
import { modelReady, type StepRegistry } from './session/manager.js';
import { createLogger, type Logger } from './util/logger.js';
import { pathToFileURL } from 'node:url';
import { createOllamaClient } from './llm/ollama.js';
import { createRpcClients, startBalanceRefresher } from './pipeline/s0-balances.js';
import { createContentFetcher } from './quarantine/fetch.js';
import { createEnsClient } from './recipients/ens-client.js';
import { createSubnameSource } from './recipients/subnames.js';
import { createExecutionClient } from './handoff/execution-client.js';
import { registry } from './pipeline/registry.js';
import { HistoryCache } from './history/cache.js';
import { createBlockscoutSource } from './history/blockscout.js';

/** Factories owned by lanes B, C and D (wired by the Orchestrator in Phase 2, see `productionFactories`). */
export interface LaneFactories {
  /** Lane B `createOllamaClient(config, log)`. */
  createLlm: (config: Config, log: AllowlistLogger) => LlmClient;
  /** Lane B `createRpcClients(config)`. */
  createRpc: (config: Config) => RpcClients;
  /** Lane B `createContentFetcher(config)`. */
  createFetcher: (config: Config) => ContentFetcher;
  /** Lane C `createEnsClient(config)`. */
  createEns: (config: Config) => EnsClient;
  /** Lane C `createSubnameSource(config)`. */
  createSubnames: (config: Config) => SubnameSource;
  /** Lane D `createExecutionClient(config, outboundToken)`. */
  createExecution: (config: Config, outboundToken: string) => ExecutionClient;
  /** src/pipeline/registry.ts `registry`. */
  registry: StepRegistry;
}

export interface MainOptions {
  /** Config path (default: env AGENT_CONFIG, else ~/.agent-layer/config.json). */
  configPath?: string;
  /** Keychain (default: the OS keychain entry agent-layer/db-key). */
  keyStore?: KeyStore;
  /** Log file (default ~/.agent-layer/logs/agent.log). */
  logFile?: string;
  /** Skip app.listen (tests). */
  listen?: boolean;
}

export interface RunningAgent {
  app: FastifyInstance;
  config: Config;
  repos: Repos;
  db: Database;
  log: Logger;
  /** Startup §14.4 check result. */
  ollama: boolean;
  close(): Promise<void>;
}

export async function main(factories: LaneFactories, opts: MainOptions = {}): Promise<RunningAgent> {
  const config = loadConfig(opts.configPath ?? configPath());
  const tokens = loadTokens(config);
  const log = createLogger(opts.logFile !== undefined ? { file: opts.logFile } : {});
  const key = getOrCreateDbKey(opts.keyStore ?? createOsKeyStore());
  // openDatabase creates the DB file's directory (mode 0700) when it is missing.
  const db = openDatabase(expandHome(config.db.path), key);
  const names = chainNames(config);
  const repos = createRepos(db, { chainName: (id) => names[id] ?? String(id) });
  repos.db5.insertDefaultsIfMissing(new Date().toISOString());

  const llm = factories.createLlm(config, log);
  const ollama = await modelReady(llm);
  log.info({ event: ollama ? 'startup_model_ok' : 'startup_model_unavailable' });

  const rpc = factories.createRpc(config);
  // Privacy fix 8: balances are read on a jittered timer from here on, not when a message arrives.
  const refresher = startBalanceRefresher({ rpc, repos, config, log });
  const history = config.history?.enabled ? new HistoryCache({
    address: config.wallet.address,
    chains: () => repos.db5.getAll().allowed_chain_ids.filter((id) => config.chains.some((chain) => chain.chain_id === id)),
    source: createBlockscoutSource(config),
    log,
  }) : undefined;
  history?.start();
  const app = createApp({
    repos,
    llm,
    rpc,
    history,
    ens: factories.createEns(config),
    subnames: factories.createSubnames(config),
    exec: factories.createExecution(config, tokens.outbound),
    fetcher: factories.createFetcher(config),
    log,
    config,
    registry: factories.registry,
    tokens: { ui: tokens.ui, report: tokens.report },
  });
  if (opts.listen !== false) {
    // §14.1 / §16.4: bound to 127.0.0.1 only (config validation accepts no other host).
    await app.listen({ host: config.server.host, port: config.server.port });
  }
  log.info({ event: 'startup_done' });
  return {
    app,
    config,
    repos,
    db,
    log,
    ollama,
    async close() {
      refresher.stop();
      history?.stop();
      await app.close();
      db.close();
      log.close();
    },
  };
}

/** Production wiring (Phase 2, Orchestrator): the lanes' real factories and the step registry. */
export const productionFactories: LaneFactories = {
  createLlm: createOllamaClient,
  createRpc: (config) => createRpcClients(config),
  createFetcher: (config) => createContentFetcher(config),
  createEns: (config) => createEnsClient(config),
  createSubnames: (config) => createSubnameSource(config),
  createExecution: createExecutionClient,
  registry,
};

// `npm start` (node dist/src/index.js) runs the agent; importing this module (tests) does not.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(productionFactories).catch(() => {
    // §18: no values in output; the error code alone, nothing from the error message.
    process.stderr.write('agent-layer: startup failed\n');
    process.exit(1);
  });
}
