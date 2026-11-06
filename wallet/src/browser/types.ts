import type { Hex } from 'viem';
import type { TxRequest } from '../chain/gateway.js';

export interface WalletCalls {
  version: '2.0.0';
  id: Hex;
  from: Hex;
  chainId: Hex;
  atomicRequired: true;
  calls: { to: Hex; data: Hex; value: Hex }[];
}

export interface WalletBatchPayload {
  /** Some wallets generate their own ID even when the request supplies one. This never permits a second dispatch. */
  providerBatchId?: string;
  calls: WalletCalls;
  expectedTx: TxRequest;
  sourceBlock: number;
  minNonce: number;
  summary: string[];
}

export interface WalletBatchRow {
  request_id: string;
  step: number;
  batch_id: Hex;
  chain_id: number;
  payload_json: string;
  status: 'draft' | 'dispatched' | 'received' | 'rejected';
  created_ms: number;
  tx_hash: Hex | null;
}
