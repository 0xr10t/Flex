// Finds the agent for the CLI, starting it when it is not running. It reads the agent's own config (env AGENT_CONFIG,
// default ~/.agent-layer/config.json) for the address, the UI token file and the wallet's URL. If nothing answers on
// the agent's port, it starts `dist/src/index.js` as a child process with that config, waits for it to come up, and
// stops it again when the CLI exits. An agent that was already running is left alone.

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError, configPath, expandHome, loadConfig } from '../../config/load.js';
import type { Config } from '../../contracts/types.js';

/** Where the agent is and how to reach it. */
export interface AgentEndpoint {
  baseUrl: string;
  token: string;
  /** The wallet (execution layer); its root serves the MetaMask approval page. */
  walletUrl: string;
  /** True when this CLI started the agent (and so stops it on exit). */
  started: boolean;
  stop(): void;
}

export type LaunchStage = 'config' | 'start' | 'token';

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
  /** Progress notes while starting. */
  onStatus?: (note: string) => void;
}

const DEFAULT_ENTRY = fileURLToPath(new URL('../../index.js', import.meta.url));
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
  const file = opts.configFile ?? configPath();
  let config: Config;
  try {
    config = loadConfig(file);
  } catch (err) {
    throw new LaunchError('config', err instanceof ConfigError ? err.errors : []);
  }
  const baseUrl = `http://${config.server.host}:${config.server.port}`;
  const walletUrl = config.execution.url.replace(/\/+$/, '') + '/';

  let child: ChildProcess | undefined;
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
      if (exited || Date.now() > deadline) {
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
    stop: () => {
      if (running && running.exitCode === null) running.kill('SIGTERM');
    },
  };
}
