// Explicit foreground launcher. It never takes over existing services or grants signing authority.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { loadConfig as loadAgent } from '../dist/src/config/load.js';
import { loadConfig as loadWallet } from '../wallet/dist/src/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentPath = resolve(root, '.local/agent.config.json');
const walletPath = resolve(root, '.local/wallet.config.json');
const children = [];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}
async function available(port) {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', () => reject(new Error('TESTNET_PORT_IN_USE')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, done);
  });
  await new Promise((done) => server.close(done));
}
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--qualify')) throw new Error('USAGE');
  const agent = loadAgent(agentPath);
  const wallet = loadWallet(walletPath);
  if (wallet.approval.mode !== 'metamask') throw new Error('METAMASK_CONFIG_REQUIRED');
  if (
    agent.wallet.address.toLowerCase() !== wallet.approval.wallet_address.toLowerCase() ||
    agent.execution.url !== `http://127.0.0.1:${wallet.server.port}` ||
    wallet.agent.url !== `http://127.0.0.1:${agent.server.port}` ||
    resolve(agent.execution.outbound_token_file) !== resolve(wallet.auth.inbound_token_file) ||
    resolve(agent.auth.execution_report_token_file) !== resolve(wallet.auth.report_token_file)
  )
    throw new Error('SERVICE_CONFIG_MISMATCH');
  if (wallet.network.socks_proxy !== null || agent.network.socks_proxy !== null)
    throw new Error('CRE_LOCAL_PROXY_UNSUPPORTED');
  for (const port of [agent.server.port, wallet.server.port, 8791]) await available(port);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const specs = [
    ['agent', ['dist/src/index.js']],
    ['wallet', ['wallet/dist/src/main.js', walletPath]],
    ['cre', ['scripts/cre-local.mjs', args[0] === '--qualify' ? 'qualify' : 'run', '--watch']],
  ];
  for (const [name, argv] of specs) {
    const child = spawn(process.execPath, argv, {
      cwd: root,
      windowsHide: true,
      stdio: 'inherit',
      env: { ...process.env, AGENT_CONFIG: agentPath },
    });
    children.push(child);
    child.on('error', () => {
      console.error(`${name}: START_FAILED`);
      process.exitCode = 1;
      stop();
    });
    child.on('exit', (code) => {
      if (!stopping) {
        console.error(`${name}: EXITED (${code ?? 'signal'})`);
        process.exitCode = 1;
        stop();
      }
    });
  }
  console.log(
    args[0] === '--qualify'
      ? 'Starting agent, MetaMask wallet and CRE provider qualification. Registered payments are not evaluated in this mode.'
      : 'Starting agent, MetaMask wallet and CRE registered-plan dry runs. Scheduled payments are not broadcast.',
  );
} catch (error) {
  console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'TESTNET_CONFIG_INVALID');
  process.exitCode = 1;
  stop();
}
