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
import { createSimulator, type SimulationConfig } from './simulation.js';
import { torFetch } from './tor-fetch.js';

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

export interface ChainTransaction extends TxRequest {
  from: Hex;
  value: bigint;
  nonce: number;
  blockNumber: number | null;
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
  stateOverrides?: Record<string, { code?: Hex; balance?: Hex }>;
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
  /** Canonical receipt at or below the chain's finalized head. No fallback to latest. */
  getFinalizedReceipt(hash: Hex): Promise<TxReceipt | null>;
  getTransaction(hash: Hex): Promise<ChainTransaction | null>;
  /** The account's mined transaction count. */
  minedNonce(): Promise<number>;
  /** A read. Throws WouldFailError if the call reverts. */
  call(to: Hex, data: Hex): Promise<Hex>;
  latestBlock(): Promise<BlockInfo>;
  finalizedBlock(): Promise<BlockInfo>;
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

/** A provider explicitly requires a narrower eth_getLogs block range. */
export class LogRangeLimitError extends ChainUnavailableError {
  constructor(readonly maxBlocks?: number) {
    super();
    this.name = 'LogRangeLimitError';
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

/**
 * `simulation`: separate simulation providers (default: the read RPC alone). `proxy`: Tor's SOCKS port
 * (`network.socks_proxy`), or null for direct connections; the simulators go through it too.
 */
export function createChainGateway(
  chainId: number,
  rpcUrl: string,
  account: LocalAccount,
  simulation?: SimulationConfig,
  proxy: string | null = null,
): ChainGateway {
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  // anon-rpc over Tor: one circuit per chain when a proxy is set.
  const transport = http(rpcUrl, { timeout: 10_000, retryCount: 0, fetchFn: torFetch(proxy, `wallet-${chainId}`) });
  // Privacy fix 3: a contract that answers with an offchain lookup would make viem fetch a URL it names, outside the RPC.
  const pub = createPublicClient({ chain, transport, pollingInterval: 250, ccipRead: false });
  const wallet = createWalletClient({ account, chain, transport, ccipRead: false });
  const simulate = createSimulator(chainId, simulation ?? { rpc_urls: [rpcUrl], quorum: 1 }, proxy);

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

    getTransaction: async (hash) => {
      try {
        const tx = await pub.getTransaction({ hash });
        if (!tx.to) return null;
        return {
          from: tx.from,
          to: tx.to,
          data: tx.input,
          value: tx.value,
          nonce: tx.nonce,
          blockNumber: tx.blockNumber === null ? null : Number(tx.blockNumber),
        };
      } catch (e) {
        if (e instanceof BaseError && e.name === 'TransactionNotFoundError') return null;
        throw new ChainUnavailableError();
      }
    },

    getFinalizedReceipt: async (hash) => {
      try {
        const r = await pub.getTransactionReceipt({ hash });
        const finalized = await pub.getBlock({ blockTag: 'finalized' });
        if (r.blockNumber > finalized.number) return null;
        const canonical = await pub.getBlock({ blockNumber: r.blockNumber });
        if (canonical.hash !== r.blockHash) return null;
        return {
          status: r.status,
          logs: r.logs,
          blockNumber: Number(r.blockNumber),
          executedAt: new Date(Number(canonical.timestamp) * 1000).toISOString(),
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

    finalizedBlock: () =>
      unavailable(
        pub
          .getBlock({ blockTag: 'finalized' })
          .then((b) => ({ number: Number(b.number), timestamp: Number(b.timestamp) })),
      ),

    blockTime: (blockNumber) =>
      unavailable(pub.getBlock({ blockNumber: BigInt(blockNumber) }).then((b) => Number(b.timestamp))),

    getLogs: (q) =>
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
        )
        .catch((error: unknown) => {
          const message = textOf(error);
          if (/block\s*range|range.*blocks|blocks?.*(?:maximum|limit)|(?:maximum|limit).*blocks?/i.test(message)) {
            const match =
              message.match(/(?:up to|limited to|maximum(?: of)?|at most)\s+(?:a\s+)?(\d+)\s+block/i) ??
              message.match(/(\d+)[ -]blocks?\s+(?:range|limit)/i);
            const limit = match ? Number(match[1]) : undefined;
            throw new LogRangeLimitError(limit && Number.isSafeInteger(limit) ? limit : undefined);
          }
          throw new ChainUnavailableError();
        }),

    simulate: async (blocks) => {
      try {
        const b = await pub.getBlock({ blockTag: 'latest' });
        return await simulate(blocks, {
          number: `0x${b.number.toString(16)}`,
          hash: b.hash,
          timestamp: `0x${b.timestamp.toString(16)}`,
        });
      } catch {
        throw new SimulationUnavailableError();
      }
    },

    signTypedData: (typed) => account.signTypedData(typed as never),
  };
}
