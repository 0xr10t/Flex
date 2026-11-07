import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { Config } from '../../contracts/types.js';
import {
  checkCancelled,
  ensureProcess,
  reusedService,
  ServiceStartError,
  type Readiness,
  type ServiceOptions,
} from './process.js';
import { PROJECT_ROOT } from './wallet.js';

export type RecurringMode = 'off' | 'dry-run' | 'broadcast';
export interface RecurringOptions extends ServiceOptions {
  projectRoot?: string;
  mode?: RecurringMode;
  portProbe?: () => Promise<boolean>;
}

function runnerListening(): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port: 8791 });
    const finish = (up: boolean) => {
      socket.destroy();
      done(up);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

/** Recurring execution is opt-in, and never changes the configured network or signing mode. */
export async function ensureRecurring(config: Config, agentFile: string, opts: RecurringOptions = {}) {
  const root = opts.projectRoot ?? PROJECT_ROOT;
  const localConfig = resolve(agentFile) === resolve(root, '.local/agent.config.json');
  const envFile = join(root, '.env');
  const saved = localConfig && existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')).FLEX_CRE_MODE : undefined;
  const mode = (opts.mode ?? process.env.FLEX_CRE_MODE ?? saved)?.trim() || 'off';
  if (!['off', 'dry-run', 'broadcast'].includes(mode))
    throw new ServiceStartError('recurring', 'FLEX_CRE_MODE must be off, dry-run, or broadcast.');
  if (mode === 'off') return { ...reusedService(), mode: 'off' as const };
  if (!localConfig)
    throw new ServiceStartError(
      'recurring',
      'The recurring runner requires the project .local configs. Use npm run testnet:setup first.',
    );
  if (config.network.socks_proxy !== null)
    throw new ServiceStartError(
      'recurring',
      'The optional CRE runner requires direct networking. Set FLEX_CRE_MODE=off to keep Tor, or explicitly choose FLEX_SOCKS_PROXY=direct and run setup again.',
    );
  if (!existsSync(join(root, '.local/cre.config.json')))
    throw new ServiceStartError('recurring', 'The recurring config is missing. Run npm run testnet:setup first.');
  const probe = async (): Promise<Readiness> => {
    checkCancelled(opts.signal);
    if (!(await (opts.portProbe ?? runnerListening)())) return 'offline';
    let state;
    try {
      state = JSON.parse(readFileSync(join(root, '.local/cre-runner/status.json'), 'utf8'));
    } catch {
      return 'waiting';
    }
    if (!Number.isFinite(Date.parse(state.time)) || Math.abs(Date.now() - Date.parse(state.time)) > 120_000)
      return 'waiting';
    if (state.status === 'starting') return 'waiting';
    if (state.status === 'failed' || state.status === 'simulation_blocked')
      throw new ServiceStartError(
        'recurring',
        'The recurring runner is blocked. Check CRE login, configured RPCs and transmitter funding; /v1/cre/status reports the reason.',
      );
    if (
      !['simulated', 'broadcast_checked', 'catching_up'].includes(state.status) ||
      state.broadcast !== (mode === 'broadcast')
    )
      throw new ServiceStartError(
        'recurring',
        'A different recurring runner is already using port 8791. Close that runner before changing FLEX_CRE_MODE.',
      );
    return 'ready';
  };
  const handle = await ensureProcess(
    {
      service: 'recurring',
      label: `the recurring-payment runner (${mode})`,
      probe,
      command: () => ({
        executable: process.execPath,
        args: [join(root, 'scripts/cre-local.mjs'), mode === 'broadcast' ? 'broadcast' : 'run', '--watch'],
        options: { cwd: root },
      }),
      failure: 'The recurring runner did not become ready. Check the CRE CLI installation, login and testnet setup.',
    },
    { ...opts, startTimeoutMs: opts.startTimeoutMs ?? 10 * 60_000 },
  );
  opts.onStatus?.(`Recurring-payment runner ready (${mode}).`);
  return { ...handle, mode: mode as RecurringMode };
}
