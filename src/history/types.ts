import type { Address, ChainId, Token } from '../contracts/types.js';

/** A successful positive incoming transfer, in integer token units. Multiple transfers can share a transaction. */
export interface ReceivedTransfer {
  id: string;
  hash: `0x${string}`;
  from: Address;
  to: Address;
  token: Token;
  units: bigint;
  timestampMs: number;
}

export interface ChainHistory {
  address: Address;
  chainId: ChainId;
  status: 'ok' | 'unavailable';
  fromMs: number;
  throughMs: number;
  transfers: readonly ReceivedTransfer[];
}

/** Reading this interface never performs network I/O. */
export interface HistoryReader {
  snapshot(chainId: ChainId): ChainHistory | undefined;
}

export interface HistorySource {
  read(chainId: ChainId, fromMs: number, throughMs: number, signal: AbortSignal): Promise<ReceivedTransfer[]>;
}

/** Hard retention/request horizon: no fetch or user-selected range may exceed seven 24-hour days. */
export const HISTORY_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
export const HISTORY_MAX_AGE_MS = 15 * 60_000;
