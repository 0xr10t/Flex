// Starts the configured local services in dependency order and checks readiness before opening a chat session.
// Existing services are reused; only this CLI's wallet, agent and optional CRE runner are stopped on exit.

import type { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, configPath, expandHome, loadConfig } from '../../config/load.js';
import type { Config } from '../../contracts/types.js';
import { loadTokens } from '../../config/tokens.js';
import { ensureTor, TorStartError } from './tor.js';
import { ensureOllama } from './ollama.js';
import { ensureWallet } from './wallet.js';
import { ensureRecurring, type RecurringMode } from './recurring.js';
import {
  checkCancelled,
  ensureProcess,
  probeHttp,
  responseObject,
  ServiceStartError,
  type Readiness,
  type ServiceHandle,
} from './process.js';
import { prepareWalletConfig } from '../onboarding/config.js';
import { WalletConnectError } from '../onboarding/connect.js';

/** What /config and /doctor show about the setup: never RPC URLs (they carry provider keys) or tokens. */
export interface AgentInfo {
  configFile: string;
  wallet: string;
  chains: string[];
  model: string;
  ollamaUrl: string;
  /** Tor's SOCKS address, or null for direct connections. */
  proxy: string | null;
  ensIndexer: boolean;
  readLinks: boolean;
  /** Plain conversation with the model (outside payments) is on. */
  chat: boolean;
}

export function agentInfo(config: Config, configFile: string): AgentInfo {
  return {
    configFile,
    wallet: config.wallet.address,
    chains: config.chains.map((c) => c.name),
    model: config.llm.model,
    ollamaUrl: config.llm.ollama_url,
    proxy: config.network.socks_proxy,
    ensIndexer: config.ens.indexer_url !== null,
    readLinks: config.fetch.enabled,
    chat: config.chat?.enabled ?? false,
  };
}

/** Where the agent is and how to reach it. */
export interface AgentEndpoint {
  baseUrl: string;
  token: string;
  /** The wallet (execution layer); its root serves the MetaMask approval page. */
  walletUrl: string;
  /** The token the agent submits to the wallet with; the CLI uses it to follow a request's progress. */
  walletToken?: string;
  /** True when this CLI started the agent (and so stops it on exit). */
  started: boolean;
  /** The setup, for /config and /doctor; absent for endpoints made without a config (tests). */
  info?: AgentInfo;
  recurring?: RecurringMode;
  stop(): void;
}

export type LaunchStage = 'config' | 'wallet' | 'tor' | 'ollama' | 'wallet-service' | 'recurring' | 'start' | 'token';

/** Why the agent could not be reached; `details` are safe to show (config field paths, not values). */
export class LaunchError extends Error {
  constructor(
    readonly stage: LaunchStage,
    readonly details: string[] = [],
  ) {
    super(stage);
  }
}

export interface LaunchOptions {
  configFile?: string;
  /** The agent's entry script; defaults to this build's dist/src/index.js. */
  entry?: string;
  /** How long to wait for a started agent (startup checks the model too). */
  startTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  ensureTorImpl?: typeof ensureTor;
  ensureOllamaImpl?: typeof ensureOllama;
  ensureWalletImpl?: typeof ensureWallet;
  ensureRecurringImpl?: typeof ensureRecurring;
  projectRoot?: string;
  walletConfigFile?: string;
  recurringMode?: RecurringMode;
  /** Desktop first-run setup is enabled by the interactive CLI, never by read-only/static commands. */
  onboard?: boolean;
  signal?: AbortSignal;
  prepareConfigImpl?: typeof prepareWalletConfig;
  /** Progress notes while starting. */
  onStatus?: (note: string) => void;
}

const DEFAULT_ENTRY = fileURLToPath(new URL('../../index.js', import.meta.url));
/** The config the testnet setup script writes into this checkout (dist/src/cli/agent → the repository root). */
const SETUP_CONFIG = fileURLToPath(new URL('../../../../.local/agent.config.json', import.meta.url));

/** The agent config to use: AGENT_CONFIG when set, else this checkout's set-up config, else the spec default. */
export function agentConfigFile(env: NodeJS.ProcessEnv = process.env, setupConfig = SETUP_CONFIG): string {
  if (env.AGENT_CONFIG) return configPath(env);
  return existsSync(setupConfig) ? setupConfig : configPath(env);
}

/** Connects to the agent, starting it first when needed. */
export async function connectAgent(opts: LaunchOptions = {}): Promise<AgentEndpoint> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let file = opts.configFile ?? agentConfigFile();
  if (opts.onboard && !opts.configFile && !process.env.AGENT_CONFIG && !existsSync(file)) file = SETUP_CONFIG;
  file = resolve(expandHome(file));
  let config: Config;
  try {
    config = opts.onboard
      ? await (opts.prepareConfigImpl ?? prepareWalletConfig)(file, { signal: opts.signal })
      : loadConfig(file);
  } catch (err) {
    if (err instanceof WalletConnectError) throw new LaunchError('wallet', [err.message]);
    throw new LaunchError('config', err instanceof ConfigError ? err.errors : []);
  }
  if (opts.signal?.aborted) throw new LaunchError('start', ['Startup cancelled.']);
  const baseUrl = `http://${config.server.host}:${config.server.port}`;
  const walletUrl = config.execution.url.replace(/\/+$/, '') + '/';
  let tokens;
  try {
    tokens = loadTokens(config);
  } catch {
    throw new LaunchError('token', ['Check the configured token files and their private file permissions.']);
  }
  const serviceOptions = {
    signal: opts.signal,
    startTimeoutMs: opts.startTimeoutMs,
    fetchImpl,
    spawnImpl: opts.spawnImpl,
    onStatus: opts.onStatus,
    projectRoot: opts.projectRoot,
  };
  const owned: ServiceHandle[] = [];
  try {
    if (config.network.socks_proxy !== null) {
      opts.onStatus?.('Checking Tor...');
      try {
        await (opts.ensureTorImpl ?? ensureTor)(
          config.network.socks_proxy,
          join(dirname(file), 'tor', new URL(config.network.socks_proxy).port),
          { onStatus: opts.onStatus, signal: opts.signal },
        );
      } catch (err) {
        checkCancelled(opts.signal);
        throw new LaunchError('tor', [err instanceof TorStartError ? err.message : new TorStartError('start').message]);
      }
      opts.onStatus?.('Tor ready.');
    }
    const ollama = await (opts.ensureOllamaImpl ?? ensureOllama)(config, serviceOptions);
    owned.push(ollama);
    const wallet = await (opts.ensureWalletImpl ?? ensureWallet)(config, file, {
      ...serviceOptions,
      tokens,
      configFile: opts.walletConfigFile,
    });
    owned.push(wallet);
    const probe = async (): Promise<Readiness> => {
      const response = await probeHttp(`${baseUrl}/v1/health`, serviceOptions, {
        authorization: `Bearer ${tokens.ui}`,
      });
      if (typeof response === 'string') return response;
      if (response.status === 401)
        throw new ServiceStartError(
          'start',
          'An agent with different credentials is using this port. Close its session or check AGENT_CONFIG.',
        );
      const body = await responseObject(response);
      if (!response.ok || body?.ok !== true || typeof body.db !== 'boolean' || typeof body.ollama !== 'boolean')
        throw new ServiceStartError(
          'start',
          'The configured agent port did not return a valid health check. Check AGENT_CONFIG and the service using that port.',
        );
      return body.db && body.ollama ? 'ready' : 'waiting';
    };
    opts.onStatus?.('Checking the agent...');
    const agent = await ensureProcess(
      {
        service: 'start',
        label: 'the agent',
        probe,
        command: () => ({
          executable: process.execPath,
          args: [opts.entry ?? DEFAULT_ENTRY],
          options: { env: { ...process.env, AGENT_CONFIG: file } },
        }),
        failure:
          'The agent did not become ready. Check its config, database and OS keychain access, then retry in flexx.',
      },
      serviceOptions,
    );
    owned.push(agent);
    const recurring = await (opts.ensureRecurringImpl ?? ensureRecurring)(config, file, {
      ...serviceOptions,
      mode: opts.recurringMode,
    });
    owned.push(recurring);
    checkCancelled(opts.signal);
    // Ollama, like Tor, is shared by other applications and survives a successful CLI session.
    ollama.detach();
    opts.onStatus?.('All required services are ready.');
    return {
      baseUrl,
      token: tokens.ui,
      walletUrl,
      walletToken: tokens.outbound,
      started: agent.started,
      info: agentInfo(config, file),
      recurring: recurring.mode,
      stop: () => {
        for (const service of [...owned].reverse()) if (service !== ollama) service.stop();
      },
    };
  } catch (error) {
    for (const service of owned.reverse()) service.stop();
    if (opts.signal?.aborted) throw new LaunchError('start', ['Startup cancelled.']);
    if (error instanceof LaunchError) throw error;
    if (error instanceof ServiceStartError) throw new LaunchError(error.service, [error.message]);
    throw new LaunchError('start', ['Service startup failed. Check the local configuration and retry in flexx.']);
  }
}
