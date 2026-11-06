// Local anvil chains that look like the real testnets: MetaMask's real contracts, placed at their real addresses, and a
// test USDC at the registered USDC address. So the wallet runs with its production constants and no test-only paths.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { SmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { deploySmartAccountsEnvironment } from '@metamask/smart-accounts-kit/utils';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  type Abi,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EIP7702_DELEGATOR } from '../../src/chain/addresses.js';
import { USDC } from '../../src/schemas/intent.v2.js';

// Public Anvil test keys. They hold nothing outside a local chain.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const USER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const userAccount = privateKeyToAccount(USER_KEY);

/** Compiled with `forge build` (see globalSetup in vitest.chain.config.ts). */
export const artifact = (file: string, name: string) =>
  JSON.parse(readFileSync(new URL(`../../contracts/out/${file}/${name}.json`, import.meta.url), 'utf8')) as {
    abi: Abi;
    bytecode: { object: Hex };
    deployedBytecode: { object: Hex };
  };

const MOCK_USDC = artifact('TestHelpers.sol', 'MockUSDC').deployedBytecode.object;

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

export interface LocalChain {
  chainId: 84532 | 421614 | 11155111;
  rpcUrl: string;
  usdc: Hex;
  pub: any;
  rpc: (method: string, params?: unknown[]) => Promise<any>;
  snapshot: () => Promise<string>;
  revert: (id: string) => Promise<void>;
  setCode: (address: Hex, code: Hex) => Promise<void>;
  usdcOf: (address: Hex) => Promise<bigint>;
  ethOf: (address: Hex) => Promise<bigint>;
  mintUsdc: (to: Hex, amount: bigint) => Promise<void>;
  env: SmartAccountsEnvironment;
  walletFor: (account: any) => any;
  /** The deployer account, which plays the operator. */
  deployer: any;
  deploy: (file: string, name: string, args?: unknown[]) => Promise<Hex>;
  setTime: (seconds: number) => Promise<void>;
  now: () => Promise<number>;
  stop: () => void;
}

export async function startChain(chainId: LocalChain['chainId'], timestamp?: number): Promise<LocalChain> {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn(
    'anvil',
    // Anvil infers Base's OP-stack rules from chain id 84532 and then refuses `prague`; keep every chain plain Ethereum.
    [
      '--port',
      String(port),
      '--chain-id',
      String(chainId),
      '--network',
      'ethereum',
      '--hardfork',
      'prague',
      '--silent',
      ...(timestamp === undefined ? [] : ['--timestamp', String(timestamp)]),
    ],
    { stdio: 'ignore' },
  );

  const rpc = async (method: string, params: unknown[] = []) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result as any;
  };
  for (let i = 0; ; i++) {
    try {
      await rpc('eth_chainId');
      break;
    } catch (e) {
      if (i > 100) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const chain = defineChain({
    id: chainId,
    name: 'local',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 50 });
  const deployer = createWalletClient({
    account: privateKeyToAccount(DEPLOYER_KEY),
    chain,
    transport: http(rpcUrl),
  });

  const env = await deploySmartAccountsEnvironment(deployer as any, pub as any, chain as any);
  const setCode = async (address: Hex, code: Hex) => {
    await rpc('anvil_setCode', [address, code]);
  };
  const implementation = env.implementations.EIP7702StatelessDeleGatorImpl as Hex;
  await setCode(EIP7702_DELEGATOR, (await pub.getCode({ address: implementation })) as Hex);

  const usdc = USDC[chainId];
  await setCode(usdc, MOCK_USDC);

  const mintUsdc = async (to: Hex, amount: bigint) => {
    const hash = await deployer.sendTransaction({
      to: usdc,
      data: encodeFunctionData({
        abi: parseAbi(['function mint(address to, uint256 amount)']),
        functionName: 'mint',
        args: [to, amount],
      }),
    });
    await pub.waitForTransactionReceipt({ hash });
  };

  return {
    chainId,
    rpcUrl,
    usdc,
    pub,
    rpc,
    snapshot: () => rpc('evm_snapshot'),
    revert: async (id) => {
      await rpc('evm_revert', [id]);
    },
    setCode,
    usdcOf: (address) => pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
    ethOf: (address) => pub.getBalance({ address }),
    mintUsdc,
    env,
    walletFor: (account) => createWalletClient({ account, chain, transport: http(rpcUrl) }),
    deployer,
    deploy: async (file, name, args = []) => {
      const { abi, bytecode } = artifact(file, name);
      const hash = await deployer.deployContract({ abi, bytecode: bytecode.object, args });
      return (await pub.waitForTransactionReceipt({ hash })).contractAddress as Hex;
    },
    setTime: async (seconds) => {
      await rpc('evm_setNextBlockTimestamp', [seconds]);
      await rpc('evm_mine');
    },
    now: async () => Number((await pub.getBlock()).timestamp),
    stop: () => proc.kill(),
  };
}
