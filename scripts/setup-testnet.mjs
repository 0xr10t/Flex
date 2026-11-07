// Generates local-only configuration. Never prints RPC URLs, credentials or tokens.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { parseEnv } from 'node:util';
import { protectPrivateFile } from '../dist/src/util/private-file.js';
import { ensureTokenFile } from '../dist/src/config/tokens.js';
import { validateConfig } from '../dist/src/config/load.js';
import { ensureTor, TorStartError } from '../dist/src/cli/agent/tor.js';
import { connectMetaMask, walletAddress } from '../dist/src/cli/onboarding/connect.js';
import { saveWalletEnv } from '../dist/src/cli/onboarding/config.js';
import { focusTerminal } from '../dist/src/cli/open.js';
import { validateSimulationConfig } from '../wallet/dist/src/chain/simulation.js';
import { parseConfig as validateWalletConfig } from '../wallet/dist/src/config.js';
import { SIMULATION_FORWARDERS } from '../wallet/dist/src/autopay/local-cre.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = resolve(root, '.local');
const envPath = resolve(root, '.env');
function privateWrite(path, content, overwrite = true) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  else if (!overwrite) return;
  protectPrivateFile(path);
  writeFileSync(path, content);
}
if (!existsSync(envPath)) privateWrite(envPath, readFileSync(resolve(root, '.env.example'), 'utf8'));
else protectPrivateFile(envPath);
const env = { ...parseEnv(readFileSync(envPath, 'utf8')), ...process.env };
if (!walletAddress(env.FLEX_WALLET_ADDRESS) && process.stdin.isTTY && !process.argv.includes('--non-interactive')) {
  console.log('Opening your default browser to connect MetaMask...');
  let connected = false;
  try {
    env.FLEX_WALLET_ADDRESS = await connectMetaMask();
    saveWalletEnv(envPath, env.FLEX_WALLET_ADDRESS);
    connected = true;
  } catch {
    console.error('Wallet connection was not completed. Run setup again, or fill FLEX_WALLET_ADDRESS locally.');
  } finally {
    await focusTerminal();
  }
  if (!connected) process.exit(2);
}
const networks = { 11155111: 'SEPOLIA', 84532: 'BASE_SEPOLIA', 421614: 'ARBITRUM_SEPOLIA' };
const required = [
  'FLEX_WALLET_ADDRESS',
  ...Object.values(networks).flatMap((name) => [name + '_RPC_URL', name + '_SIMULATION_RPC_URLS']),
];
const missing = required.filter((name) => !env[name]?.trim());
for (const name of Object.values(networks)) {
  if (env[name + '_SIMULATION_RPC_URLS']?.trim() === '[]') missing.push(name + '_SIMULATION_RPC_URLS');
}
for (const name of ['ui_token', 'execution_outbound_token', 'execution_report_token'])
  ensureTokenFile(resolve(local, name));
if (missing.length) {
  console.log('Created protected .env and service tokens. Fill: ' + missing.join(', '));
  process.exitCode = 2;
} else {
  const rpc = { 11155111: env.SEPOLIA_RPC_URL, 84532: env.BASE_SEPOLIA_RPC_URL, 421614: env.ARBITRUM_SEPOLIA_RPC_URL };
  const simulations = {};
  for (const [id, name] of Object.entries(networks)) {
    try {
      const simulation = {
        rpc_urls: JSON.parse(env[name + '_SIMULATION_RPC_URLS']),
        quorum: Number(env[name + '_SIMULATION_QUORUM'] || 2),
      };
      validateSimulationConfig(simulation);
      simulations[id] = simulation;
    } catch {
      throw new Error(
        'Invalid simulation configuration for ' + name + '; use 1-3 distinct URLs and a strict majority quorum.',
      );
    }
  }
  for (const value of Object.values(rpc)) {
    try {
      const url = new URL(value);
      if (
        url.hash ||
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      )
        throw new Error();
    } catch {
      throw new Error('RPCs must use valid HTTPS URLs or loopback HTTP URLs');
    }
  }
  const cfg = JSON.parse(readFileSync(resolve(root, 'config.example.json'), 'utf8'));
  // Keep an existing explicit transport choice. A fresh setup retains the template's Tor default.
  const previousPath = resolve(local, 'agent.config.json');
  if (existsSync(previousPath)) {
    const previous = JSON.parse(readFileSync(previousPath, 'utf8'));
    if (previous.network) cfg.network = previous.network;
    if (previous.chat) cfg.chat = previous.chat;
  }
  if (env.FLEX_SOCKS_PROXY)
    cfg.network = { socks_proxy: env.FLEX_SOCKS_PROXY === 'direct' ? null : env.FLEX_SOCKS_PROXY };
  cfg.wallet.address = env.FLEX_WALLET_ADDRESS;
  cfg.chains.forEach((chain) => {
    chain.rpc_url = rpc[chain.chain_id];
  });
  cfg.auth.ui_token_file = resolve(local, 'ui_token');
  cfg.auth.execution_report_token_file = resolve(local, 'execution_report_token');
  cfg.execution.outbound_token_file = resolve(local, 'execution_outbound_token');
  cfg.db.path = resolve(local, 'agent.db');
  cfg.llm.ollama_url = env.OLLAMA_URL || cfg.llm.ollama_url;
  cfg.llm.model = env.OLLAMA_MODEL || cfg.llm.model;
  cfg.ens.indexer_url = env.ENS_INDEXER_URL || cfg.ens.indexer_url;
  // An Omnigraph URL left over from an older .env keeps its own kind instead of being read as an RPC.
  cfg.ens.indexer_kind =
    env.ENS_INDEXER_KIND ||
    (env.ENS_INDEXER_URL?.endsWith('/api/omnigraph') ? 'ensnode-omnigraph' : cfg.ens.indexer_kind);
  if (env.ENS_REGISTRY_START_BLOCK) cfg.ens.registry_start_block = Number(env.ENS_REGISTRY_START_BLOCK);
  cfg.autopay = {
    late_window_seconds: Number(env.AUTOPAY_LATE_WINDOW_SECONDS || cfg.autopay.late_window_seconds),
    fee: { USDC: env.AUTOPAY_FEE_USDC || cfg.autopay.fee.USDC, ETH: env.AUTOPAY_FEE_ETH || cfg.autopay.fee.ETH },
    fee_collector: env.AUTOPAY_FEE_COLLECTOR || env.FLEX_WALLET_ADDRESS,
  };
  cfg.bridge = { ccip_fee_max_eth: env.CCIP_FEE_MAX_ETH || cfg.bridge.ccip_fee_max_eth };
  validateConfig(cfg);
  const deploymentsPath = resolve(local, 'deployments.json');
  const deployments = {
    ...JSON.parse(readFileSync(resolve(root, 'wallet/cre/deployments.testnet.json'), 'utf8')),
    ...(existsSync(deploymentsPath) ? JSON.parse(readFileSync(deploymentsPath, 'utf8')) : {}),
  };
  const wallet = {
    // The wallet listens where the agent sends (execution.url) and reports to where the agent listens (server).
    server: { host: '127.0.0.1', port: Number(new URL(cfg.execution.url).port || 80) },
    agent: { url: `http://${cfg.server.host}:${cfg.server.port}` },
    auth: {
      inbound_token_file: cfg.execution.outbound_token_file,
      report_token_file: cfg.auth.execution_report_token_file,
    },
    db: { path: resolve(local, 'wallet.db') },
    approval: { mode: 'metamask', wallet_address: env.FLEX_WALLET_ADDRESS },
    network: { ...cfg.network },
    bridge: { ccip_fee_max_eth: cfg.bridge.ccip_fee_max_eth },
    chains: cfg.chains.map((chain) => ({
      chain_id: chain.chain_id,
      rpc_url: chain.rpc_url,
      simulation: simulations[chain.chain_id],
      ...(deployments[chain.chain_id]
        ? {
            executor: {
              address: deployments[chain.chain_id].address,
              deployment_block: deployments[chain.chain_id].deployment_block,
            },
          }
        : {}),
    })),
  };
  validateWalletConfig(wallet);
  const cre = JSON.parse(readFileSync(resolve(root, 'wallet/cre/autopay/config.staging.json'), 'utf8'));
  cre.mode = 'testnet-dry-run';
  cre.maxSimulationsPerRun = 1;
  cre.walletAddress = env.FLEX_WALLET_ADDRESS;
  delete cre.workflow;
  for (const chain of cre.chains) {
    chain.forwarder = SIMULATION_FORWARDERS[chain.chainId];
    chain.simulation.quorum = simulations[chain.chainId].quorum;
    const deployment = deployments[chain.chainId];
    if (deployment) {
      chain.executor = deployment.address;
      chain.deploymentBlock = String(deployment.deployment_block);
    }
  }
  privateWrite(resolve(local, 'cre.config.json'), JSON.stringify(cre, null, 2) + '\n');
  privateWrite(resolve(local, 'agent.config.json'), JSON.stringify(cfg, null, 2) + '\n');
  privateWrite(resolve(local, 'wallet.config.json'), JSON.stringify(wallet, null, 2) + '\n');
  console.log(
    'Created protected agent, wallet and CRE configs in .local. MetaMask approves and submits each browser batch.',
  );
  if (cfg.network.socks_proxy !== null) {
    try {
      await ensureTor(cfg.network.socks_proxy, resolve(local, 'tor', new URL(cfg.network.socks_proxy).port), {
        onStatus: (note) => console.log(note),
      });
      console.log('Tor is ready. flexx checks and starts Tor automatically whenever it opens.');
    } catch (err) {
      console.error(err instanceof TorStartError ? err.message : 'Tor could not start. Check your Tor installation.');
      process.exitCode = 2;
    }
  }
}
