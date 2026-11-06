// Native CRE build/simulation runner. Deliberately has no --broadcast or deployment path.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import process from 'node:process';
import console from 'node:console';
import { setTimeout as delay } from 'node:timers/promises';
import { protectPrivateFile } from '../dist/src/util/private-file.js';
import { indexPlans, rpcClient } from './cre-indexer.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = join(root, 'wallet/cre');
const local = join(root, '.local/cre-runner');
const binary = join(root, '.local/autopay.wasm');
const manifestPath = join(local, 'build.json');
const rpcNames = { 11155111: 'SEPOLIA_RPC_URL', 84532: 'BASE_SEPOLIA_RPC_URL', 421614: 'ARBITRUM_SEPOLIA_RPC_URL' };
const hash = (v) => createHash('sha256').update(v).digest('hex');

export function assertLocalNetwork(walletConfig) {
  // Native CRE HTTP/EVM capabilities do not inherit the Node wallet's SOCKS transport.
  // Until a verified local capability proxy exists, refusing is safer than silently sending wallet data directly.
  if (walletConfig?.network?.socks_proxy != null) throw new Error('CRE_LOCAL_PROXY_UNSUPPORTED');
}

export function optionsOf(args) {
  const options = {
    command: args[0] ?? 'qualify',
    watch: false,
    intervalSeconds: 30,
    iterations: 1,
    rebuild: true,
    config: join(root, '.local/cre.config.json'),
  };
  if (!['build', 'qualify', 'run'].includes(options.command)) throw new Error('USAGE');
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--watch') {
      options.watch = true;
      options.iterations = Infinity;
    } else if (a === '--no-build') options.rebuild = false;
    else if (a === '--config') {
      if (!args[i + 1]) throw new Error('USAGE');
      options.config = resolve(args[++i]);
    } else if (a === '--interval-seconds' || a === '--iterations') {
      const value = Number(args[++i]);
      if (!Number.isSafeInteger(value) || value < (a === '--interval-seconds' ? 30 : 1) || value > 86400)
        throw new Error('USAGE');
      if (a === '--interval-seconds') options.intervalSeconds = value;
      else options.iterations = value;
    } else throw new Error('USAGE');
  }
  if (!options.watch && options.iterations > 1) throw new Error('USAGE');
  return options;
}

export function privateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 });
  try {
    protectPrivateFile(temporary);
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export async function acquireLock(path, port = 8791) {
  mkdirSync(dirname(path), { recursive: true });
  // The OS releases this exclusive loopback listener on crash; PID files never control lock ownership.
  const server = createServer((socket) => socket.destroy());
  await new Promise((done, reject) => {
    server.once('error', () => reject(new Error('RUNNER_LOCKED')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, done);
  });
  const token = randomBytes(16).toString('hex');
  try {
    privateJson(path, { pid: process.pid, token });
  } catch (error) {
    server.close();
    throw error;
  }
  const release = async () => {
    try {
      if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path);
    } catch {
      /* Informational file only. */
    }
    await new Promise((done) => server.close(done));
  };
  release.port = server.address().port;
  return release;
}

function sourceHash() {
  const paths = [
    'wallet/cre/autopay/main.ts',
    'wallet/cre/autopay/package.json',
    'wallet/cre/autopay/package-lock.json',
    'wallet/cre/autopay/bun.lock',
  ];
  for (const folder of ['wallet/cre/autopay/lib', 'packages/protocol/dist']) {
    const visit = (dir) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const p = `${dir}/${entry.name}`;
        if (entry.isDirectory()) visit(p);
        else if (/\.(?:ts|js|json)$/.test(p)) paths.push(p);
      }
    };
    visit(folder);
  }
  return hash(
    paths
      .sort()
      .map((p) => `${p}:${hash(readFileSync(join(root, p)))}`)
      .join('\n'),
  );
}

export function parseSimulationOutput(output) {
  const marker = output.lastIndexOf('Workflow Simulation Result:');
  if (marker < 0) throw new Error('CRE_RESULT_MISSING');
  const text = output.slice(marker + 'Workflow Simulation Result:'.length).trimStart();
  // CLI prints the handler's JSON string as a JSON value (or, in some versions, directly as an object).
  for (let end = text.length; end > 0; end--) {
    if (!['}', '"'].includes(text[end - 1])) continue;
    try {
      let result = JSON.parse(text.slice(0, end));
      if (typeof result === 'string') result = JSON.parse(result);
      if (typeof result?.result === 'string') result = JSON.parse(result.result);
      if (!result || !['local-simulation', 'dry-run'].includes(result.mode)) continue;
      return result;
    } catch {
      /* Ignore surrounding CLI status text; never log raw tool output. */
    }
  }
  throw new Error('CRE_RESULT_INVALID');
}

async function cli(args, signal) {
  const command = process.env.CRE_CLI_PATH || join(root, '.local/bin/cre.exe');
  return await new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: project,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      timeout: 180_000,
    });
    let output = '';
    let exceeded = false;
    const collect = (data) => {
      if (exceeded) return;
      output += data.toString();
      if (output.length > 8_000_000) {
        exceeded = true;
        output = '';
        child.kill();
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => reject(new Error(signal?.aborted ? 'STOPPED' : 'CRE_START_FAILED')));
    child.on('close', (code) => {
      if (signal?.aborted) return reject(new Error('STOPPED'));
      if (exceeded) return reject(new Error('CRE_OUTPUT_LIMIT'));
      if (code !== 0) {
        const known = [
          'simulation quorum unavailable',
          'invalid CRE configuration',
          'plan discovery requires local indexer',
          'snapshot reorg detected',
          'simulation anchor stale',
        ];
        const reason = known.find((s) => output.includes(s));
        return reject(new Error(reason ? reason.toUpperCase().replaceAll(' ', '_') : 'CRE_COMMAND_FAILED'));
      }
      done(output);
    });
  });
}

export function verifyArtifact() {
  if (!existsSync(binary) || !existsSync(manifestPath)) throw new Error('BUILD_REQUIRED');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.sourceHash !== sourceHash() || manifest.wasmHash !== hash(readFileSync(binary)))
    throw new Error('BUILD_STALE');
  return manifest;
}

async function build(signal) {
  const inputs = sourceHash();
  await cli(
    [
      'workflow',
      'build',
      'autopay',
      '--target',
      'local-simulation',
      '--env',
      join(root, '.env'),
      '--non-interactive',
      '--output',
      binary,
    ],
    signal,
  );
  if (sourceHash() !== inputs) throw new Error('BUILD_INPUT_CHANGED');
  const manifest = {
    sourceHash: inputs,
    wasmHash: hash(readFileSync(binary)),
    builtAt: new Date().toISOString(),
  };
  privateJson(manifestPath, manifest);
  return manifest;
}

async function simulate(config, target, signal) {
  verifyArtifact();
  const configPath = join(local, 'invocation.json');
  privateJson(configPath, config);
  // This allowlisted command cannot publish a workflow or broadcast a transaction.
  const output = await cli(
    [
      'workflow',
      'simulate',
      'autopay',
      '--target',
      target,
      '--env',
      join(root, '.env'),
      '--config',
      configPath,
      '--wasm',
      binary,
      '--non-interactive',
      '--trigger-index',
      '0',
    ],
    signal,
  );
  const result = parseSimulationOutput(output);
  if (result.mode !== config.mode) throw new Error('CRE_RESULT_MODE_MISMATCH');
  return result;
}

async function tick(options, signal) {
  if (options.command === 'qualify') {
    const template = JSON.parse(readFileSync(join(project, 'autopay/config.staging.json'), 'utf8'));
    const results = [];
    for (const { chainId, selector, simulation } of template.chains) {
      results.push(
        await simulate(
          { mode: 'local-simulation', schedule: template.schedule, chains: [{ chainId, selector, simulation }] },
          'local-simulation',
          signal,
        ),
      );
    }
    return { status: 'qualified', results };
  }
  const config = JSON.parse(readFileSync(options.config, 'utf8'));
  // Explicitly require read-only payment mode. A changed source config cannot escalate this runner to broadcasts.
  if (
    config.mode !== 'dry-run' ||
    !Array.isArray(config.chains) ||
    config.chains.length < 1 ||
    config.chains.length > 3 ||
    config.chains.some(
      (c) => !/^0x[0-9a-fA-F]{40}$/.test(c.executor) || /^0x0+$/.test(c.executor) || !rpcNames[c.chainId],
    )
  )
    throw new Error('EXECUTOR_CONFIG_REQUIRED');
  const env = { ...parseEnv(readFileSync(join(root, '.env'), 'utf8')), ...process.env };
  const indexPath = join(local, 'index.json');
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { version: 1, chains: {} };
  if (index.version !== 1 || !index.chains) throw new Error('INDEX_INVALID');
  let caughtUp = true;
  const progress = [];
  for (const chain of config.chains) {
    const url = env[rpcNames[chain.chainId]];
    if (!url || !url.startsWith('https://')) throw new Error('RPC_CONFIG_REQUIRED');
    const result = await indexPlans(chain, index.chains[chain.chainId], rpcClient(url, globalThis.fetch, signal), {
      onCheckpoint: async (state) => {
        index.chains[chain.chainId] = state;
        privateJson(indexPath, index);
      },
    });
    caughtUp &&= result.caughtUp;
    progress.push({
      chainId: chain.chainId,
      caughtUp: result.caughtUp,
      blockNumber: result.state?.snapshot.blockNumber,
    });
    chain.snapshot = result.state?.snapshot;
  }
  if (!caughtUp) return { status: 'catching_up', progress };
  const result = await simulate(config, 'staging-settings', signal);
  return { status: result.results.some((entry) => entry.skipped) ? 'simulation_blocked' : 'simulated', result };
}

export async function main(args = process.argv.slice(2)) {
  const options = optionsOf(args);
  const walletConfigPath = join(root, '.local/wallet.config.json');
  if (existsSync(walletConfigPath)) assertLocalNetwork(JSON.parse(readFileSync(walletConfigPath, 'utf8')));
  const release = await acquireLock(join(local, 'runner.lock'));
  const controller = new globalThis.AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let failed = false;
  try {
    const manifest = options.rebuild ? await build(controller.signal) : verifyArtifact();
    console.log(JSON.stringify({ status: 'built', wasmHash: manifest.wasmHash, broadcast: false }));
    if (options.command === 'build') return;
    for (let iteration = 0; iteration < options.iterations && !controller.signal.aborted; iteration++) {
      const start = Date.now();
      try {
        const result = await tick(options, controller.signal);
        privateJson(join(local, 'status.json'), {
          ...result,
          time: new Date().toISOString(),
          wasmHash: manifest.wasmHash,
        });
        console.log(JSON.stringify(result));
        failed = result.status === 'simulation_blocked' || result.status === 'catching_up';
      } catch (error) {
        if (controller.signal.aborted) break;
        const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_RUN_FAILED';
        privateJson(join(local, 'status.json'), { status: 'failed', code, time: new Date().toISOString() });
        console.error(code);
        failed = true;
        if (!options.watch) throw new Error(code);
      }
      if (iteration + 1 < options.iterations)
        await delay(Math.max(0, options.intervalSeconds * 1000 - (Date.now() - start)), undefined, {
          signal: controller.signal,
        }).catch(() => {});
    }
    if (failed) process.exitCode = 1;
  } finally {
    await release();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_RUN_FAILED');
    process.exitCode = 1;
  });
}
