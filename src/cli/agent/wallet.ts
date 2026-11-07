import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expandHome } from '../../config/load.js';
import { loadTokens, type Tokens } from '../../config/tokens.js';
import type { Config } from '../../contracts/types.js';
import {
  ensureProcess,
  probeHttp,
  responseObject,
  ServiceStartError,
  type Readiness,
  type ServiceOptions,
} from './process.js';

export const PROJECT_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export interface WalletOptions extends ServiceOptions {
  projectRoot?: string;
  configFile?: string;
  tokens?: Tokens;
}

/** The startup fields of the wallet's own config; its compiled loader validates the complete schema. */
interface WalletConfig {
  server: { host: string; port: number };
  agent: { url: string };
  auth: { inbound_token_file: string; report_token_file: string };
  approval: { mode: string; wallet_address?: string };
  network: { socks_proxy: string | null };
  chains: Array<{ chain_id: number }>;
}

const canonical = (url: string) => url.replace(/\/+$/, '');

export async function ensureWallet(config: Config, agentFile: string, opts: WalletOptions = {}) {
  const root = opts.projectRoot ?? PROJECT_ROOT;
  const file = resolve(
    expandHome(opts.configFile ?? process.env.FLEX_WALLET_CONFIG ?? join(dirname(agentFile), 'wallet.config.json')),
  );
  const entry = join(root, 'wallet/dist/src/main.js');
  const configModule = join(root, 'wallet/dist/src/config.js');
  const badConfig = () =>
    new ServiceStartError(
      'wallet-service',
      'The wallet config is missing, invalid, or does not match the agent. Run npm run testnet:setup, or set FLEX_WALLET_CONFIG.',
    );
  if (!existsSync(entry) || !existsSync(configModule))
    throw new ServiceStartError(
      'wallet-service',
      'The wallet build is missing. Run npm run testnet:build once, then reopen flexx.',
    );
  const tokens = opts.tokens ?? loadTokens(config);
  try {
    const loader = (await import(pathToFileURL(configModule).href)) as { loadConfig(file: string): WalletConfig };
    const wallet = loader.loadConfig(file);
    const read = (path: string) => readFileSync(expandHome(path), 'utf8').trim();
    if (
      canonical(config.execution.url) !== `http://${wallet.server.host}:${wallet.server.port}` ||
      canonical(wallet.agent.url) !== `http://${config.server.host}:${config.server.port}` ||
      wallet.network.socks_proxy !== config.network.socks_proxy ||
      wallet.approval.mode !== 'metamask' ||
      wallet.approval.wallet_address?.toLowerCase() !== config.wallet.address.toLowerCase() ||
      read(wallet.auth.inbound_token_file) !== tokens.outbound ||
      read(wallet.auth.report_token_file) !== tokens.report ||
      config.chains.some((chain) => !wallet.chains.some((c) => c.chain_id === chain.chain_id))
    )
      throw badConfig();
  } catch {
    throw badConfig();
  }
  const probe = async (): Promise<Readiness> => {
    const response = await probeHttp(`${canonical(config.execution.url)}/v1/health`, opts, {
      authorization: `Bearer ${tokens.outbound}`,
    });
    if (typeof response === 'string') return response;
    const body = await responseObject(response);
    if (
      body.service !== 'flex-wallet' ||
      typeof body.wallet_address !== 'string' ||
      body.wallet_address.toLowerCase() !== config.wallet.address.toLowerCase()
    )
      throw new ServiceStartError(
        'wallet-service',
        'Another or older wallet service is using this port. Close its session, then retry in flexx.',
      );
    if (response.status === 503 && body.db === false) return 'waiting';
    if (!response.ok || body.ok !== true || body.db !== true)
      throw new ServiceStartError(
        'wallet-service',
        'The wallet did not pass its authenticated health check. Check its config and keychain access.',
      );
    return 'ready';
  };
  opts.onStatus?.('Checking the wallet service...');
  const handle = await ensureProcess(
    {
      service: 'wallet-service',
      label: 'the wallet service',
      probe,
      command: () => ({ executable: process.execPath, args: [entry, file], options: { cwd: root } }),
      failure:
        'The wallet did not become ready. Check its config, database and OS keychain access, then retry in flexx.',
    },
    opts,
  );
  opts.onStatus?.('Wallet service ready.');
  return handle;
}
