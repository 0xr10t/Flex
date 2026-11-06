// Everything the wallet asks of a chain. The runner uses this interface, so its ordering and crash tests can run without
// a chain. The errors separate "this transaction can't work" from "the chain can't be reached", because only the first
// may fail a step: a step whose outcome is unknown must not be reported as failed.

import {
  BaseError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  type AbiEvent,
  type Hex,
  type LocalAccount,
  type Log,
} from 'viem';
import type { SignTypedData } from '../autopay/delegation.js';
import { EIP7702_DELEGATOR } from './addresses.js';

export interface TxRequest {
  to: Hex;
  data: Hex;
}

export interface TxReceipt {
  status: 'success' | 'reverted';
  logs: Log[];
  executedAt: string;
  blockNumber: number;
}

export interface LogQuery {
  address: Hex;
  event: AbiEvent;
  args?: Record<string, unknown>;
  fromBlock: number;
  toBlock: number;
}

export interface ChainLog {
  args: Record<string, unknown>;
  blockNumber: number;
  transactionHash: Hex;
  logIndex: number;
}

export interface BlockInfo {
  number: number;
  timestamp: number;
}

export interface SimCall {
  from: Hex;
  to: Hex;
  data: Hex;
}

export interface SimBlock {
  calls: SimCall[];
  /** Simulate at this time, for a run that's due later. */
  time?: number;
  stateOverrides?: Record<string, { code?: Hex }>;
  /** May fail without failing the check. */
  probe?: boolean;
}

export interface SimCallResult {
  status: 'success' | 'failure';
  logs: Log[];
}

export interface SignedTx {
  raw: Hex;
  hash: Hex;
  nonce: number;
}

export interface ChainGateway {
  getCode(address: Hex): Promise<Hex | undefined>;
  /** Sends the tested 7702 upgrade: a transaction to self carrying the authorization. Resolves once it is mined. */
  sendUpgrade(): Promise<void>;
  /** Estimates, fills in and signs. Nothing is sent. Throws WouldFailError if the transaction can't succeed. */
  prepareAndSign(tx: TxRequest): Promise<SignedTx>;
  /** Safe to repeat with the same transaction. */
  broadcast(raw: Hex): Promise<void>;
  /** Null until the transaction is mined. */
  getReceipt(hash: Hex): Promise<TxReceipt | null>;
  /** The account's mined transaction count. */
  minedNonce(): Promise<number>;
  /** A read. Throws WouldFailError if the call reverts. */
  call(to: Hex, data: Hex): Promise<Hex>;
  latestBlock(): Promise<BlockInfo>;
  blockTime(blockNumber: number): Promise<number>;
  getLogs(query: LogQuery): Promise<ChainLog[]>;
  /** `eth_simulateV1`, with ETH transfers traced as logs. One result list per block. Throws SimulationUnavailableError. */
  simulate(blocks: SimBlock[]): Promise<SimCallResult[][]>;
  /** EIP-712 signing through the account, so another signer can stand in for the raw key. */
  signTypedData: SignTypedData;
}

/** The chain says this transaction would fail: it reverts, or the account can't pay for it. */
export class WouldFailError extends Error {
  constructor() {
    super('transaction would fail');
    this.name = 'WouldFailError';
  }
}

/** The chain couldn't be reached or gave no usable answer. Safe to try again. */
export class ChainUnavailableError extends Error {
  constructor() {
    super('chain unavailable');
    this.name = 'ChainUnavailableError';
  }
}

/** `eth_simulateV1` couldn't run, so nothing can be signed: there's no fallback (user decision, 6 Nov 2026). */
export class SimulationUnavailableError extends Error {
  constructor() {
    super('simulation unavailable');
    this.name = 'SimulationUnavailableError';
  }
}

const WOULD_FAIL = new Set([
  'ExecutionRevertedError',
  'ContractFunctionRevertedError',
  'InsufficientFundsError',
  'EstimateGasExecutionError',
]);

const isWouldFail = (e: unknown): boolean =>
  e instanceof BaseError && e.walk((cause) => WOULD_FAIL.has((cause as Error).name)) !== null;

// A node refuses a repeat of a transaction it has already seen. That is the outcome a repeat wants.
const ALREADY_SEEN = /already known|already imported|nonce too low|nonce has already been used|replacement/i;

const textOf = (e: unknown): string => (e instanceof BaseError ? `${e.shortMessage} ${e.details ?? ''}` : String(e));

export function createChainGateway(chainId: number, rpcUrl: string, account: LocalAccount): ChainGateway {
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl, { timeout: 10_000, retryCount: 0 });
  const pub = createPublicClient({ chain, transport, pollingInterval: 250 });
  const wallet = createWalletClient({ account, chain, transport });

  const unavailable = <T>(work: Promise<T>): Promise<T> =>
    work.catch((e: unknown) => {
      if (e instanceof WouldFailError) throw e;
      throw new ChainUnavailableError();
    });

  return {
    getCode: (address) => unavailable(pub.getCode({ address })),

    sendUpgrade: () =>
      unavailable(
        (async () => {
          const authorization = await wallet.signAuthorization({
            contractAddress: EIP7702_DELEGATOR,
            executor: 'self',
          });
          const hash = await wallet.sendTransaction({
            authorizationList: [authorization],
            to: account.address,
            data: '0x',
          });
          await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
        })(),
      ),

    prepareAndSign: (tx) =>
      unavailable(
        (async () => {
          let prepared;
          try {
            prepared = await wallet.prepareTransactionRequest({ to: tx.to, data: tx.data, value: 0n });
          } catch (e) {
            if (isWouldFail(e)) throw new WouldFailError();
            throw e;
          }
          const raw = await wallet.signTransaction(prepared);
          return { raw, hash: keccak256(raw), nonce: prepared.nonce };
        })(),
      ),

    broadcast: async (raw) => {
      try {
        await pub.sendRawTransaction({ serializedTransaction: raw });
      } catch (e) {
        if (!ALREADY_SEEN.test(textOf(e))) throw new ChainUnavailableError();
      }
    },

    getReceipt: async (hash) => {
      try {
        const r = await pub.getTransactionReceipt({ hash });
        const block = await pub.getBlock({ blockHash: r.blockHash });
        return {
          status: r.status,
          logs: r.logs,
          executedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
          blockNumber: Number(r.blockNumber),
        };
      } catch (e) {
        if (e instanceof BaseError && e.name === 'TransactionReceiptNotFoundError') return null;
        throw new ChainUnavailableError();
      }
    },

    minedNonce: () => unavailable(pub.getTransactionCount({ address: account.address, blockTag: 'latest' })),

    call: (to, data) =>
      unavailable(
        (async () => {
          try {
            const { data: result } = await pub.call({ account: account.address, to, data });
            return result ?? '0x';
          } catch (e) {
            if (isWouldFail(e)) throw new WouldFailError();
            throw e;
          }
        })(),
      ),

    latestBlock: () =>
      unavailable(
        pub
          .getBlock({ blockTag: 'latest' })
          .then((b) => ({ number: Number(b.number), timestamp: Number(b.timestamp) })),
      ),

    blockTime: (blockNumber) =>
      unavailable(pub.getBlock({ blockNumber: BigInt(blockNumber) }).then((b) => Number(b.timestamp))),

    getLogs: (q) =>
      unavailable(
        pub
          .getLogs({
            address: q.address,
            event: q.event,
            ...(q.args ? { args: q.args as never } : {}),
            fromBlock: BigInt(q.fromBlock),
            toBlock: BigInt(q.toBlock),
          })
          .then((logs) =>
            logs.map((l) => ({
              args: (l as unknown as { args: Record<string, unknown> }).args,
              blockNumber: Number(l.blockNumber),
              transactionHash: l.transactionHash as Hex,
              logIndex: l.logIndex as number,
            })),
          ),
      ),

    simulate: async (blocks) => {
      let result: { calls: { status: string; logs?: unknown[] }[] }[];
      try {
        result = (await pub.request({
          method: 'eth_simulateV1' as never,
          params: [
            {
              blockStateCalls: blocks.map((b) => ({
                calls: b.calls,
                ...(b.time === undefined ? {} : { blockOverrides: { time: `0x${b.time.toString(16)}` } }),
                ...(b.stateOverrides ? { stateOverrides: b.stateOverrides } : {}),
              })),
              traceTransfers: true,
              validation: false,
            },
            'latest',
          ] as never,
        })) as never;
      } catch {
        throw new SimulationUnavailableError();
      }
      if (!Array.isArray(result) || result.length !== blocks.length) throw new SimulationUnavailableError();
      return result.map((block) =>
        block.calls.map((c) => ({
          status: c.status === '0x1' ? ('success' as const) : ('failure' as const),
          logs: (c.logs ?? []) as Log[],
        })),
      );
    },

    signTypedData: (typed) => account.signTypedData(typed as never),
  };
}
