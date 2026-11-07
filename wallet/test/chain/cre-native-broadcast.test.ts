// Opt-in native CRE broadcasting, exclusively to local Anvil chains. Only public Anvil fixture keys are used.
// Runtime code for the official mock forwarders is read from the configured public testnet RPCs, never written there.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { beforeAll, describe, expect, it } from 'vitest';
import { keccak256, parseEventLogs, type Hex } from 'viem';
import { USDC } from '@flex/protocol/schemas/intent.v2';
import { EXECUTOR_ABI } from '../../src/autopay/abi.js';
import { verifiedIntent } from '../../src/autopay/autopay-k.js';
import { redeemFor, signAutopayDelegation } from '../../src/autopay/delegation.js';
import { SIMULATION_FORWARDERS } from '../../src/autopay/local-cre.js';
import { EIP7702_DELEGATOR } from '../../src/chain/addresses.js';
import { autopay, envelope, ALEX } from '../support/envelopes.js';
import { artifact, startChain, userAccount, USER_KEY } from './harness.js';
// @ts-expect-error Host helpers are executable ESM.
import { indexPlans, rpcClient } from '../../../scripts/cre-indexer.mjs';
// @ts-expect-error Host helpers are executable ESM.
import { parseSimulationOutput, verifyArtifact } from '../../../scripts/cre-local.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const selectors: Record<number, string> = {
  11155111: '16015286601757825753',
  84532: '10344971235874465080',
  421614: '3478487238524512106',
};
const names: Record<number, string> = {
  11155111: 'ethereum-testnet-sepolia',
  84532: 'ethereum-testnet-sepolia-base-1',
  421614: 'ethereum-testnet-sepolia-arbitrum-1',
};
async function cli(args: string[], cwd: string) {
  return new Promise<string>((done, reject) => {
    const child = spawn(
      process.env.CRE_CLI_PATH || resolve(root, '.local/bin', process.platform === 'win32' ? 'cre.exe' : 'cre'),
      args,
      { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 150000 },
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
        : reject(
            new Error(`Native CRE test exited ${code}: ${output.replace(/https?:\/\/\S+/g, '[RPC]').slice(-2200)}`),
          ),
    );
  });
}

describe.skipIf(process.env.FLEX_NATIVE_CRE !== '1')(
  'native CRE --broadcast on three local testnet-shaped chains',
  () => {
    const codes = new Map<number, Hex>();
    beforeAll(async () => {
      verifyArtifact();
      const config = JSON.parse(readFileSync(resolve(root, '.local/wallet.config.json'), 'utf8'));
      for (const chain of config.chains) {
        const rpc = rpcClient(chain.rpc_url);
        const code = await rpc('eth_getCode', [SIMULATION_FORWARDERS[chain.chain_id], 'latest']);
        if (code === '0x') throw new Error('MOCK_FORWARDER_MISSING');
        codes.set(chain.chain_id, code);
      }
    }, 90000);

    it.each([11155111, 84532, 421614] as const)(
      'broadcasts a real local payment on chain %s, skips its paid slot, and respects cancellation',
      async (chainId) => {
        const chain = await startChain(chainId, Math.floor(Date.now() / 1000) - 7200);
        try {
          const dir = resolve(root, `.local/cre-native-broadcast-${chainId}`);
          mkdirSync(resolve(dir, 'autopay'), { recursive: true });
          const forwarder = SIMULATION_FORWARDERS[chainId]!;
          await chain.setCode(forwarder, codes.get(chainId)!);
          const { abi, bytecode } = artifact('IntentExecutorV4.sol', 'IntentExecutorV4');
          const deployed = await chain
            .walletFor(userAccount)
            .deployContract({ abi, bytecode: bytecode.object, args: [forwarder, chain.env.DelegationManager] });
          const executor = (await chain.pub.waitForTransactionReceipt({ hash: deployed })).contractAddress!;
          const nonce = await chain.pub.getTransactionCount({ address: userAccount.address });
          const authorization = await userAccount.signAuthorization({
            address: EIP7702_DELEGATOR,
            chainId,
            nonce: nonce + 1,
          });
          const upgrade = await chain
            .walletFor(userAccount)
            .sendTransaction({ authorizationList: [authorization], to: userAccount.address, data: '0x' });
          await chain.pub.waitForTransactionReceipt({ hash: upgrade });
          await chain.mintUsdc(userAccount.address, 100_000_000n);
          const start = (await chain.now()) + 3600;
          const intent = {
            ...autopay(0, start, [[ALEX, '1']], { runs: 3, interval: 7200, late: 7199 }),
            chain_id: chainId as 11155111 | 84532 | 421614,
            token_address: USDC[chainId]!,
          };
          const verified = verifiedIntent(envelope([intent]), 0);
          const delegation = await signAutopayDelegation(
            {
              intent: verified,
              delegator: userAccount.address,
              executor,
              chainId,
              env: chain.env,
              startAt: start,
              endAt: intent.schedule.end_at,
            },
            (data) => userAccount.signTypedData(data as never),
          );
          const redeem = redeemFor(verified, delegation),
            id = keccak256(redeem);
          const registered = await chain.walletFor(userAccount).writeContract({
            address: executor,
            abi: EXECUTOR_ABI,
            functionName: 'register',
            args: [BigInt(start), 7200n, 7199n, 3n, redeem],
          });
          await chain.pub.waitForTransactionReceipt({ hash: registered });
          await chain.setTime(Math.floor(Date.now() / 1000) - 1);
          const source = {
            chainId,
            selector: selectors[chainId],
            executor,
            forwarder,
            deploymentBlock: '0',
            simulation: { urlsSecret: 'TEST_SIM_URLS', quorum: 2 },
          };
          writeFileSync(
            resolve(dir, 'project.yaml'),
            `staging-settings:\n  rpcs:\n    - chain-name: ${names[chainId]}\n      url: ${chain.rpcUrl}\n`,
          );
          writeFileSync(
            resolve(dir, 'autopay/workflow.yaml'),
            `staging-settings:\n  user-workflow:\n    workflow-name: flex-native-broadcast-test\n    deployment-registry: private\n  workflow-artifacts:\n    workflow-path: ${JSON.stringify(resolve(root, 'wallet/cre/autopay/main.ts'))}\n    config-path: ../config.json\n    secrets-path: ../secrets.yaml\n`,
          );
          writeFileSync(resolve(dir, 'secrets.yaml'), 'secretsNames:\n  TEST_SIM_URLS:\n    - TEST_SIM_ENDPOINTS\n');
          // Public local-only fixture key and RPC URLs, never copied from the user's environment.
          writeFileSync(
            resolve(dir, 'test.env'),
            `CRE_ETH_PRIVATE_KEY=${USER_KEY}\nTEST_SIM_ENDPOINTS='${JSON.stringify([`${chain.rpcUrl}/?a`, `${chain.rpcUrl}/?b`, `${chain.rpcUrl}/?c`])}'\n`,
          );
          const run = async (broadcast: boolean) => {
            await chain.rpc('anvil_mine', ['0x41', '0x0']);
            const indexed = await indexPlans(source, null, rpcClient(chain.rpcUrl));
            const config = {
              mode: broadcast ? 'testnet-broadcast' : 'testnet-dry-run',
              schedule: '*/30 * * * * *',
              maxSimulationsPerRun: 1,
              walletAddress: userAccount.address,
              ...(broadcast ? { expectedRun: { id, slot: '0' } } : {}),
              chains: [{ ...source, snapshot: indexed.state.snapshot }],
            };
            writeFileSync(resolve(dir, 'config.json'), JSON.stringify(config));
            return parseSimulationOutput(
              await cli(
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
                  resolve(root, '.local/autopay.wasm'),
                  '--non-interactive',
                  '--trigger-index',
                  '0',
                  ...(broadcast ? ['--broadcast'] : []),
                ],
                dir,
              ),
            );
          };
          const before = await chain.usdcOf(ALEX);
          expect(await run(false)).toMatchObject({ due: 1, results: [{ status: 'would_execute' }] });
          expect(await chain.usdcOf(ALEX)).toBe(before);
          const result = await run(true);
          expect(result).toMatchObject({ due: 1, results: [{ status: 'submitted' }] });
          const receipt = await chain.pub.waitForTransactionReceipt({ hash: result.results[0].tx });
          expect(parseEventLogs({ abi: EXECUTOR_ABI, logs: receipt.logs, eventName: 'Executed' })).toHaveLength(1);
          expect(await chain.usdcOf(ALEX)).toBe(before + 1_000_000n);
          expect(await run(true)).toMatchObject({ due: 0 });
          const cancel = await chain
            .walletFor(userAccount)
            .writeContract({ address: executor, abi: EXECUTOR_ABI, functionName: 'cancel', args: [id] });
          await chain.pub.waitForTransactionReceipt({ hash: cancel });
          expect(await run(true)).toMatchObject({ due: 0 });
          expect(await chain.usdcOf(ALEX)).toBe(before + 1_000_000n);
        } finally {
          chain.stop();
        }
      },
      360000,
    );
  },
);
