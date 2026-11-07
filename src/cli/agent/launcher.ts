// Finds the agent for the CLI, starting it when it is not running. It reads the agent's own config (env AGENT_CONFIG,
// else the checkout's .local/agent.config.json that `node scripts/setup-testnet.mjs` writes, else
// ~/.agent-layer/config.json) for the address, the UI token file and the wallet's URL. If nothing answers on
// the agent's port, it starts `dist/src/index.js` as a child process with that config, waits for it to come up, and
// stops it again when the CLI exits. An agent that was already running is left alone.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, configPath, expandHome, loadConfig } from '../../config/load.js';
import type { Config } from '../../contracts/types.js';
import { ensureTor, TorStartError } from './tor.js';
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
  /** True when this CLI started the agent (and so stops it on exit). */
  started: boolean;
  /** The setup, for /config and /doctor; absent for endpoints made without a config (tests). */
  info?: AgentInfo;
  stop(): void;
}

export type LaunchStage = 'config' | 'wallet' | 'tor' | 'start' | 'token';

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
const POLL_MS = 250;

/** True when anything answers HTTP on the agent's port (even 401: the agent wants its token). */
async function listening(baseUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    await fetchImpl(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

function readToken(config: Config): string {
  try {
    const token = readFileSync(expandHome(config.auth.ui_token_file), 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(token)) return token;
  } catch {
    // reported below
  }
  throw new LaunchError('token', [config.auth.ui_token_file]);
}

/** Connects to the agent, starting it first when needed. */
export async function connectAgent(opts: LaunchOptions = {}): Promise<AgentEndpoint> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let file = opts.configFile ?? agentConfigFile();
  if (opts.onboard && !opts.configFile && !process.env.AGENT_CONFIG && !existsSync(file)) file = SETUP_CONFIG;
  let config: Config;
  try {
    config = opts.onboard
      ? await (opts.prepareConfigImpl ?? prepareWalletConfig)(file, { signal: opts.signal })
      : loadConfig(file);
  } catch (err) {
    if (err instanceof WalletConnectError) throw new LaunchError('wallet', [err.message]);
    throw new LaunchError('config', err instanceof ConfigError ? err.errors : []);
  }
  if (opts.signal?.aborted) throw new LaunchError('wallet', ['Wallet connection cancelled.']);
  const baseUrl = `http://${config.server.host}:${config.server.port}`;
  const walletUrl = config.execution.url.replace(/\/+$/, '') + '/';

  if (config.network.socks_proxy !== null) {
    try {
      await (opts.ensureTorImpl ?? ensureTor)(
        config.network.socks_proxy,
        join(dirname(file), 'tor', new URL(config.network.socks_proxy).port),
        { onStatus: opts.onStatus },
      );
    } catch (err) {
      throw new LaunchError('tor', [err instanceof TorStartError ? err.message : new TorStartError('start').message]);
    }
  }

  let child: ChildProcess | undefined;
  if (opts.signal?.aborted) throw new LaunchError('start');
  if (!(await listening(baseUrl, fetchImpl))) {
    opts.onStatus?.('starting the agent');
    child = (opts.spawnImpl ?? spawn)(process.execPath, [opts.entry ?? DEFAULT_ENTRY], {
      env: { ...process.env, AGENT_CONFIG: file },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    child.once('error', () => {
      exited = true;
    });
    const deadline = Date.now() + (opts.startTimeoutMs ?? 60_000);
    while (!(await listening(baseUrl, fetchImpl))) {
      if (exited || opts.signal?.aborted || Date.now() > deadline) {
        child.kill('SIGTERM');
        throw new LaunchError('start');
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  const running = child;
  let token: string;
  try {
    token = readToken(config);
  } catch (err) {
    running?.kill('SIGTERM');
    throw err;
  }
  return {
    baseUrl,
    token,
    walletUrl,
    started: running !== undefined,
    info: agentInfo(config, file),
    stop: () => {
      if (running && running.exitCode === null) running.kill('SIGTERM');
    },
  };
}
