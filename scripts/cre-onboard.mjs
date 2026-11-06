// Loopback-only MetaMask onboarding. This service never loads or uses a wallet private key.
import Fastify from 'fastify';
import { createRequire } from 'node:module';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { decodeFunctionResult, encodeDeployData, encodeFunctionData, formatEther, parseAbi } from 'viem';
import { privateJson, root } from './cre-local.mjs';
import { rpcClient } from './cre-indexer.mjs';
import { checkReceiver } from './cre-broadcast.mjs';
import { SIMULATION_FORWARDERS } from '../wallet/dist/src/autopay/local-cre.js';
import { UPGRADED_CODE } from '../wallet/dist/src/chain/addresses.js';

const walletRequire = createRequire(new URL('../wallet/package.json', import.meta.url));
const { getSmartAccountsEnvironment } = walletRequire('@metamask/smart-accounts-kit');
const names = { 11155111: 'Ethereum Sepolia', 84532: 'Base Sepolia', 421614: 'Arbitrum Sepolia' };
const ownerAbi = parseAbi([
  'function owner() view returns (address)',
  'function delegationManager() view returns (address)',
]);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export async function startOnboarding(port = 8792) {
  const walletPath = resolve(root, '.local/wallet.config.json');
  const wallet = JSON.parse(readFileSync(walletPath, 'utf8'));
  if (wallet.approval.mode !== 'metamask' || wallet.network?.socks_proxy != null)
    throw new Error('LOCAL_METAMASK_CONFIG_REQUIRED');
  const address = wallet.approval.wallet_address;
  const artifact = JSON.parse(
    readFileSync(resolve(root, 'wallet/contracts/out/IntentExecutorV3.sol/IntentExecutorV3.json'), 'utf8'),
  );
  const journalPath = resolve(root, '.local/cre-onboarding.json');
  const deploymentsPath = resolve(root, '.local/deployments.json');
  const journal = existsSync(journalPath)
    ? JSON.parse(readFileSync(journalPath, 'utf8'))
    : { wallet: address, chains: {} };
  if (!same(journal.wallet, address)) throw new Error('ONBOARDING_WALLET_MISMATCH');
  const save = () => privateJson(journalPath, journal);
  const configs = new Map(wallet.chains.map((c) => [c.chain_id, c]));
  const info = (id) => {
    const config = configs.get(id);
    if (!config || !names[id]) throw new Error('TESTNET_REQUIRED');
    const manager = getSmartAccountsEnvironment(id).DelegationManager;
    const forwarder = SIMULATION_FORWARDERS[id];
    const data = encodeDeployData({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [forwarder, manager],
    });
    return { rpc: rpcClient(config.rpc_url), manager, forwarder, data };
  };
  const applyDeployment = (id, deployment) => {
    const deployments = existsSync(deploymentsPath) ? JSON.parse(readFileSync(deploymentsPath, 'utf8')) : {};
    deployments[id] = deployment;
    privateJson(deploymentsPath, deployments);
    // Update only the executor fields; preserve all current RPC, auth, policy and network settings.
    const currentWallet = JSON.parse(readFileSync(walletPath, 'utf8'));
    currentWallet.chains.find((c) => c.chain_id === id).executor = {
      address: deployment.address,
      deployment_block: deployment.deployment_block,
    };
    privateJson(walletPath, currentWallet);
    const crePath = resolve(root, '.local/cre.config.json');
    const cre = JSON.parse(readFileSync(crePath, 'utf8'));
    const chain = cre.chains.find((c) => c.chainId === id);
    chain.executor = deployment.address;
    chain.deploymentBlock = String(deployment.deployment_block);
    chain.forwarder = SIMULATION_FORWARDERS[id];
    privateJson(crePath, cre);
  };
  const inspect = async (id) => {
    const { rpc, forwarder, manager } = info(id);
    const entry = journal.chains[id] ?? {};
    if (entry.hash && !entry.address) {
      const [receipt, tx] = await Promise.all([
        rpc('eth_getTransactionReceipt', [entry.hash]),
        rpc('eth_getTransactionByHash', [entry.hash]),
      ]);
      if (receipt && tx) {
        if (
          !same(tx.from, address) ||
          tx.to !== null ||
          !same(tx.input, entry.data) ||
          BigInt(tx.value) !== 0n ||
          !same(receipt.transactionHash, entry.hash) ||
          !same(receipt.from, address)
        )
          throw new Error('DEPLOYMENT_TRANSACTION_MISMATCH');
        if (receipt.status !== '0x1' || !receipt.contractAddress) {
          entry.failed = true;
          save();
        } else {
          await checkReceiver({ chainId: id, executor: receipt.contractAddress, forwarder }, address, rpc, address);
          const actualManager = decodeFunctionResult({
            abi: ownerAbi,
            functionName: 'delegationManager',
            data: await rpc('eth_call', [
              {
                to: receipt.contractAddress,
                data: encodeFunctionData({ abi: ownerAbi, functionName: 'delegationManager' }),
              },
              'latest',
            ]),
          });
          if (!same(actualManager, manager)) throw new Error('DELEGATION_MANAGER_MISMATCH');
          const deployment = {
            address: receipt.contractAddress,
            deployment_block: Number(BigInt(receipt.blockNumber)),
            transaction_hash: entry.hash,
            forwarder,
          };
          applyDeployment(id, deployment);
          entry.address = receipt.contractAddress;
          save();
        }
      }
    }
    const [code, balance] = await Promise.all([
      rpc('eth_getCode', [address, 'latest']),
      rpc('eth_getBalance', [address, 'latest']),
    ]);
    return {
      chainId: id,
      name: names[id],
      forwarder,
      testEth: formatEther(BigInt(balance)),
      upgraded: same(code, UPGRADED_CODE),
      accountCodePresent: code !== '0x',
      executor: entry.address ?? configs.get(id).executor?.address ?? null,
      hash: entry.hash ?? null,
      pending: Boolean(entry.hash && !entry.address && !entry.failed),
      failed: Boolean(entry.failed),
    };
  };
  const app = Fastify({ logger: false, bodyLimit: 4096 });
  const session = randomBytes(32).toString('hex');
  const host = `127.0.0.1:${port}`;
  const authenticated = (req) => {
    const cookie = req.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('flex_cre_setup='))
      ?.slice(15);
    return (
      req.headers.host === host &&
      req.headers['x-flex-setup'] === '1' &&
      cookie?.length === session.length &&
      timingSafeEqual(Buffer.from(cookie), Buffer.from(session)) &&
      (!req.headers.origin || req.headers.origin === `http://${host}`)
    );
  };
  app.addHook('onRequest', async (req, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    if (req.headers.host !== host) return reply.code(403).send();
    if (
      req.url.startsWith('/api/') &&
      (!authenticated(req) || (req.method === 'POST' && req.headers.origin !== `http://${host}`))
    )
      return reply.code(403).send({ error: 'LOCAL_SESSION_REQUIRED' });
  });
  for (const [url, file, type] of [
    ['/', 'index.html', 'text/html'],
    ['/setup.js', 'setup.js', 'text/javascript'],
    ['/setup.css', 'setup.css', 'text/css'],
  ]) {
    app.get(url, (_, reply) => {
      reply.header(
        'content-security-policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      if (url === '/') reply.header('set-cookie', `flex_cre_setup=${session}; HttpOnly; SameSite=Strict; Path=/`);
      return reply.type(type).send(readFileSync(new URL(`./cre-onboarding/${file}`, import.meta.url), 'utf8'));
    });
  }
  let inspecting;
  app.get('/api/state', async () => {
    inspecting ??= Promise.all(
      [...configs.keys()].map(async (id) => {
        try {
          return await inspect(id);
        } catch (error) {
          return {
            chainId: id,
            name: names[id],
            error: /^[A-Z_]+$/.test(error.message) ? error.message : 'CHAIN_UNAVAILABLE',
          };
        }
      }),
    ).finally(() => {
      inspecting = null;
    });
    return { wallet: address, chains: await inspecting };
  });
  const preparing = new Set();
  app.post('/api/prepare', async (req) => {
    const id = req.body?.chainId;
    if (preparing.has(id)) throw new Error('DEPLOYMENT_PREPARING');
    preparing.add(id);
    try {
      const state = await inspect(id);
      if (state.executor || state.pending || state.hash) throw new Error('DEPLOYMENT_ALREADY_RECORDED');
      if (journal.chains[id]?.awaitingWallet) throw new Error('DEPLOYMENT_HASH_REQUIRED');
      const { rpc, data, forwarder, manager } = info(id);
      const [chainId, forwarderCode, managerCode, mined, pending] = await Promise.all([
        rpc('eth_chainId', []),
        rpc('eth_getCode', [forwarder, 'latest']),
        rpc('eth_getCode', [manager, 'latest']),
        rpc('eth_getTransactionCount', [address, 'latest']),
        rpc('eth_getTransactionCount', [address, 'pending']),
      ]);
      if (BigInt(chainId) !== BigInt(id) || forwarderCode === '0x' || managerCode === '0x')
        throw new Error('CHAIN_CONTRACTS_REQUIRED');
      if (mined !== pending) throw new Error('WALLET_TRANSACTION_PENDING');
      const tx = { from: address, data, value: '0x0' };
      const estimated = BigInt(await rpc('eth_estimateGas', [tx]));
      const price = BigInt(await rpc('eth_gasPrice', []));
      const gas = (estimated * 12n) / 10n;
      journal.chains[id] = { data, nonce: mined, awaitingWallet: true, preparedAt: new Date().toISOString() };
      save();
      return {
        transaction: { ...tx, nonce: mined, gas: `0x${gas.toString(16)}` },
        estimatedEth: formatEther(gas * price),
      };
    } finally {
      preparing.delete(id);
    }
  });
  app.post('/api/hash', async (req) => {
    const { chainId, hash } = req.body ?? {};
    info(chainId);
    const entry = journal.chains[chainId];
    if (!entry?.data || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('PREPARED_DEPLOYMENT_REQUIRED');
    if (entry.hash && !same(entry.hash, hash)) throw new Error('DEPLOYMENT_HASH_ALREADY_RECORDED');
    entry.hash = hash;
    save();
    return { saved: true };
  });
  app.post('/api/rejected', async (req) => {
    const id = req.body?.chainId,
      { rpc } = info(id),
      entry = journal.chains[id];
    if (!entry || entry.hash) throw new Error('DEPLOYMENT_ALREADY_RECORDED');
    const [mined, pending] = await Promise.all([
      rpc('eth_getTransactionCount', [address, 'latest']),
      rpc('eth_getTransactionCount', [address, 'pending']),
    ]);
    if (mined !== entry.nonce || pending !== entry.nonce) throw new Error('DEPLOYMENT_HASH_REQUIRED');
    delete journal.chains[id];
    save();
    return { reset: true };
  });
  app.setErrorHandler((error, _, reply) =>
    reply.code(400).send({ error: /^[A-Z_]+$/.test(error.message) ? error.message : 'SETUP_UNAVAILABLE' }),
  );
  await app.listen({ host: '127.0.0.1', port });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startOnboarding()
    .then((app) => {
      console.log('CRE testnet setup: http://127.0.0.1:8792');
      process.once('SIGINT', () => void app.close());
      process.once('SIGTERM', () => void app.close());
    })
    .catch((error) => {
      console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'SETUP_START_FAILED');
      process.exitCode = 1;
    });
}
