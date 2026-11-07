import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { ConfigError, loadConfig, validateConfig } from '../../config/load.js';
import type { Config } from '../../contracts/types.js';
import { focusTerminal } from '../open.js';
import { connectMetaMask, walletAddress, WalletConnectError } from './connect.js';

const PROJECT_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function privateWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

/** Appending respects dotenv's last-value-wins semantics and preserves comments and multiline values verbatim. */
export function saveWalletEnv(path: string, address: string): void {
  const selected = walletAddress(address);
  if (!selected) throw new WalletConnectError('setup');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (walletAddress(parseEnv(text).FLEX_WALLET_ADDRESS) === selected) return;
  privateWrite(
    path,
    `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n# Wallet selected for Flexx\nFLEX_WALLET_ADDRESS=${selected}\n`,
  );
}

function runSetup(root: string, address: string, signal?: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      [join(root, 'scripts/setup-testnet.mjs'), '--non-interactive'],
      {
        cwd: root,
        env: { ...process.env, FLEX_WALLET_ADDRESS: address },
        signal,
        timeout: 180_000,
        maxBuffer: 32 * 1024,
      },
      (error, stdout) => {
        if (!error) return done();
        if (signal?.aborted) return fail(new WalletConnectError('cancelled'));
        const missing = /Fill: ([A-Z0-9_, ]+)/.exec(stdout)?.[1];
        fail(
          missing
            ? new ConfigError([`Fill these settings in ${join(root, '.env')}: ${missing}`])
            : new WalletConnectError('setup'),
        );
      },
    );
  });
}

export interface WalletConfigOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  connect?: typeof connectMetaMask;
  focus?: () => Promise<boolean>;
  setup?: typeof runSetup;
}

/** Used only by the interactive CLI. A valid saved address never opens the browser again. */
export async function prepareWalletConfig(file: string, opts: WalletConfigOptions = {}): Promise<Config> {
  const root = opts.projectRoot ?? PROJECT_ROOT;
  const isProjectConfig = resolve(file) === resolve(root, '.local/agent.config.json');
  let raw: Record<string, unknown> | undefined;
  if (existsSync(file)) {
    try {
      raw = record(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      throw new ConfigError(['config file is not readable JSON']);
    }
    if (walletAddress(record(raw.wallet).address)) return loadConfig(file);
  } else if (!isProjectConfig) throw new ConfigError(['config file not readable']);

  const envPath = join(root, '.env');
  const env = {
    ...(isProjectConfig && existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}),
    ...(opts.env ?? process.env),
  };
  let selected = walletAddress(env.FLEX_WALLET_ADDRESS);
  let prompted = false;
  try {
    if (!selected) {
      prompted = true;
      selected = await (opts.connect ?? connectMetaMask)({ signal: opts.signal });
    }
    opts.signal?.throwIfAborted();
    selected = walletAddress(selected);
    if (!selected) throw new WalletConnectError('setup');
    if (isProjectConfig) saveWalletEnv(envPath, selected);
    if (!raw) {
      await (opts.setup ?? runSetup)(root, selected, opts.signal);
      return loadConfig(file);
    }
    raw.wallet = { ...record(raw.wallet), address: selected };
    // The example's optional fee collector can default to the selected wallet, just as setup-testnet does.
    if (raw.autopay && !walletAddress(record(raw.autopay).fee_collector))
      raw.autopay = { ...record(raw.autopay), fee_collector: selected };
    const config = validateConfig(raw);
    if (isProjectConfig) {
      for (const name of ['wallet.config.json', 'cre.config.json']) {
        const path = join(dirname(file), name);
        if (!existsSync(path)) continue;
        const sibling = JSON.parse(readFileSync(path, 'utf8'));
        if (name === 'wallet.config.json') {
          if (sibling.approval?.mode !== 'metamask') continue;
          sibling.approval.wallet_address = selected;
        } else sibling.walletAddress = selected;
        privateWrite(path, JSON.stringify(sibling, null, 2) + '\n');
      }
    }
    privateWrite(file, JSON.stringify(config, null, 2) + '\n');
    return config;
  } finally {
    if (prompted && !opts.signal?.aborted) await (opts.focus ?? focusTerminal)().catch(() => false);
  }
}
