// Opt-in native CLI integration. All accounts, contracts and transactions below exist ONLY on local Anvil.
// CRE authentication is needed, but no funded public-testnet wallet and no deployment access are used.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFunctionData, type Hex } from 'viem';
import { EXECUTOR_ABI } from '../../src/autopay/abi.js';
import { verifiedIntent } from '../../src/autopay/autopay-k.js';
import { redeemFor, signAutopayDelegation } from '../../src/autopay/delegation.js';
import { userAccount } from './harness.js';
import { autopay, envelope, ALEX } from '../support/envelopes.js';
import { startWorld, type World } from './world.js';
// @ts-expect-error Native host helpers are executable ESM, not TypeScript build inputs.
import { indexPlans, rpcClient } from '../../../scripts/cre-indexer.mjs';
// @ts-expect-error See above.
import { parseSimulationOutput } from '../../../scripts/cre-local.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const dir = resolve(root, '.local/cre-native-test');
let world: World;
async function cli(args: string[], cwd = resolve(root, 'wallet/cre')) {
  return new Promise<string>((done, reject) => {
    const child = spawn(
      process.env.CRE_CLI_PATH || resolve(root, '.local/bin', process.platform === 'win32' ? 'cre.exe' : 'cre'),
      args,
      {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (d) => {
      output += String(d);
    });
    child.stderr.on('data', (d) => {
      output += String(d);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? done(output)
        : reject(new Error(`Native CRE exited ${code}: ${output.replace(/https?:\/\/\S+/g, '[RPC]').slice(-3500)}`)),
    );
  });
}

describe.skipIf(process.env.FLEX_NATIVE_CRE !== '1')(
  'native CRE against real local executor and delegation contracts',
  () => {
    beforeAll(async () => {
      mkdirSync(dir, { recursive: true });
      mkdirSync(resolve(dir, 'autopay'), { recursive: true });
      world = await startWorld(Math.floor(Date.now() / 1000) - 7200);
      writeFileSync(
        resolve(dir, 'autopay/workflow.yaml'),
        `staging-settings:\n  user-workflow:\n    workflow-name: flex-native-local-test\n    deployment-registry: private\n  workflow-artifacts:\n    workflow-path: ${JSON.stringify(resolve(root, 'wallet/cre/autopay/main.ts'))}\n    config-path: ../config.json\n    secrets-path: ../secrets.yaml\n`,
      );
      writeFileSync(
        resolve(dir, 'secrets.yaml'),
        'secretsNames:\n  BASE_SEPOLIA_SIMULATION_RPC_URLS:\n    - TEST_BASE_RPC_ENDPOINTS\n',
      );
      writeFileSync(
        resolve(dir, 'project.yaml'),
        `staging-settings:\n  rpcs:\n    - chain-name: ethereum-testnet-sepolia-base-1\n      url: ${world.base.rpcUrl}\n`,
      );
      // Public local-only endpoints: three paths exercise aggregation, not infrastructure independence.
      writeFileSync(
        resolve(dir, 'test.env'),
        `TEST_BASE_RPC_ENDPOINTS='${JSON.stringify([`${world.base.rpcUrl}/?provider=a`, `${world.base.rpcUrl}/?provider=b`, `${world.base.rpcUrl}/?provider=c`])}'\n`,
      );
      await cli([
        'workflow',
        'build',
        'autopay',
        '--target',
        'local-simulation',
        '--env',
        resolve(root, '.env'),
        '--non-interactive',
        '--output',
        resolve(dir, 'autopay.wasm'),
      ]);
    }, 180_000);
    afterAll(async () => {
      if (world) await world.stop();
    });

    it('runs a due payment through native WASM without moving funds, then observes actual local execution and skips its slot', async () => {
      const start = (await world.base.now()) + 3000;
      const intent = autopay(0, start, [[ALEX, '10']], { runs: 3, interval: 3600, late: 3599 });
      const executor = world.executorOf(world.base);
      const verified = verifiedIntent(envelope([intent]), 0);
      await world.upgrade(world.base, userAccount);
      const delegation = await signAutopayDelegation(
        {
          intent: verified,
          delegator: userAccount.address,
          executor,
          chainId: 84532,
          env: world.base.env,
          startAt: start,
          endAt: intent.schedule.end_at,
        },
        (data) => userAccount.signTypedData(data as never),
      );
      const redeem = redeemFor(verified, delegation);
      const registration = await world.base.walletFor(userAccount).sendTransaction({
        to: executor,
        data: encodeFunctionData({
          abi: EXECUTOR_ABI,
          functionName: 'register',
          args: [BigInt(start), 3600n, 3599n, 3n, redeem],
        }),
      });
      await world.base.pub.waitForTransactionReceipt({ hash: registration });
      await world.base.setTime(Math.floor(Date.now() / 1000) - 1);
      const forwarder = (await world.base.pub.readContract({
        address: executor,
        abi: EXECUTOR_ABI,
        functionName: 'getForwarderAddress',
      })) as Hex;
      const chain = {
        chainId: 84532,
        selector: '10344971235874465080',
        executor,
        forwarder,
        deploymentBlock: '0',
        simulation: { urlsSecret: 'BASE_SEPOLIA_SIMULATION_RPC_URLS', quorum: 2 },
      };
      const config = {
        mode: 'dry-run',
        schedule: '*/30 * * * * *',
        maxSimulationsPerRun: 2,
        workflow: {
          // Explicit local test identity. The local MockForwarder has no DON and identity checks are unset on this test receiver.
          id: `0x${'01'.repeat(32)}`,
          name: `0x${'01'.repeat(10)}`,
          owner: ALEX,
        },
        chains: [chain],
      };
      const run = async () => {
        // Anvil's finalized tag trails its head by 64 blocks. Advance finality without advancing wall-clock time.
        await world.base.rpc('anvil_mine', ['0x41', '0x0']);
        const indexed = await indexPlans(chain, null, rpcClient(world.base.rpcUrl));
        expect(indexed.caughtUp).toBe(true);
        expect(indexed.state.snapshot.plans).toHaveLength(1);
        writeFileSync(
          resolve(dir, 'config.json'),
          JSON.stringify({ ...config, chains: [{ ...chain, snapshot: indexed.state.snapshot }] }),
        );
        const output = await cli(
          [
            'workflow',
            'simulate',
            'autopay',
            '--project-root',
            dir,
            '--target',
            'staging-settings',
            '--env',
            resolve(dir, 'test.env'),
            '--config',
            resolve(dir, 'config.json'),
            '--wasm',
            resolve(dir, 'autopay.wasm'),
            '--non-interactive',
            '--trigger-index',
            '0',
          ],
          dir,
        );
        return parseSimulationOutput(output);
      };
      const before = await world.base.usdcOf(ALEX);
      const result = await run();
      expect(result).toMatchObject({ mode: 'dry-run', due: 1, results: [{ status: 'would_execute' }] });
      expect(await world.base.usdcOf(ALEX)).toBe(before);
      const delivered = await world.deliver(world.base, redeem);
      expect(delivered.paid).toBe(true);
      expect(await world.base.usdcOf(ALEX)).toBe(before + 10_000_000n);
      expect(await run()).toMatchObject({ mode: 'dry-run', due: 0, results: [] });
    }, 180_000);
  },
);
