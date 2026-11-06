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
import { validateSimulationConfig } from '../wallet/dist/src/chain/simulation.js';
import { parseConfig as validateWalletConfig } from '../wallet/dist/src/config.js';

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
  validateConfig(cfg);
  const deploymentsPath = resolve(local, 'deployments.json');
  const deployments = existsSync(deploymentsPath) ? JSON.parse(readFileSync(deploymentsPath, 'utf8')) : {};
  const wallet = {
    server: { host: '127.0.0.1', port: 8788 },
    agent: { url: 'http://127.0.0.1:8787' },
    auth: {
      inbound_token_file: cfg.execution.outbound_token_file,
      report_token_file: cfg.auth.execution_report_token_file,
    },
    db: { path: resolve(local, 'wallet.db') },
    approval: { mode: 'metamask', wallet_address: env.FLEX_WALLET_ADDRESS },
    network: { socks_proxy: cfg.network.socks_proxy },
    bridge: { ccip_fee_max_eth: env.CCIP_FEE_MAX_ETH || '0.003' },
    chains: cfg.chains.map((chain) => ({
      chain_id: chain.chain_id,
      rpc_url: chain.rpc_url,
      simulation: simulations[chain.chain_id],
      ...(deployments[chain.chain_id] ? { executor: deployments[chain.chain_id] } : {}),
    })),
  };
  validateWalletConfig(wallet);
  const cre = JSON.parse(readFileSync(resolve(root, 'wallet/cre/autopay/config.staging.json'), 'utf8'));
  for (const chain of cre.chains) {
    chain.simulation.quorum = simulations[chain.chainId].quorum;
    const deployment = deployments[chain.chainId];
    if (deployment) {
      chain.executor = deployment.address;
      chain.deploymentBlock = String(deployment.deployment_block);
    }
  }
  if (env.CRE_WORKFLOW_ID) cre.workflow.id = env.CRE_WORKFLOW_ID;
  if (env.CRE_WORKFLOW_NAME_HEX) cre.workflow.name = env.CRE_WORKFLOW_NAME_HEX;
  if (env.CRE_WORKFLOW_OWNER) cre.workflow.owner = env.CRE_WORKFLOW_OWNER;
  privateWrite(resolve(local, 'cre.config.json'), JSON.stringify(cre, null, 2) + '\n');
  privateWrite(resolve(local, 'agent.config.json'), JSON.stringify(cfg, null, 2) + '\n');
  privateWrite(resolve(local, 'wallet.config.json'), JSON.stringify(wallet, null, 2) + '\n');
  console.log(
    'Created protected agent, wallet and CRE configs in .local. MetaMask approves and submits each browser batch.',
  );
}
