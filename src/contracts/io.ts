// Implements: §14.5 chain RPC / ENS / indexer boundaries, §14.2 execution client boundary,
// §8.2 step 3 URL fetcher boundary, §18 allowlist logger interface.
// Owned by the Orchestrator (frozen contract). Mocks live in test/fakes/io.ts.

import type { Address, ChainId, HandoffEnvelope } from './types.js';

/** §8.1 / §14.5: one viem public client per chain, 10 s timeout, no retries. Rejects on failure/timeout. */
export interface RpcClients {
  /** Native ETH balance of wallet.address, in wei. */
  getEthBalance(chain_id: ChainId): Promise<bigint>;
  /** USDC balanceOf(wallet.address) on the chain's usdc_address, in base units. */
  getUsdcBalance(chain_id: ChainId): Promise<bigint>;
}

/** Thrown when the ENS RPC call fails/times out (distinct from "no address" = null). */
export class EnsUnavailable extends Error {
  constructor() {
    super('ENS lookup unavailable');
    this.name = 'EnsUnavailable';
  }
}

/** §9.3 / §14.5: getEnsAddress via the Universal Resolver on ens.rpc_chain_id. */
export interface EnsClient {
  /** `name` must already be ENSIP-15 normalized. Resolves null when there is no address record for coinType. */
  getAddress(name: string, coinType: bigint): Promise<Address | null>;
}

/** Thrown on indexer error/timeout (10 s) → ENS_INDEXER_UNAVAILABLE (§9.6 step 3). */
export class IndexerUnavailable extends Error {
  constructor() {
    super('ENS indexer unavailable');
    this.name = 'IndexerUnavailable';
  }
}

/** §9.6 step 3: direct children of namehash(parent), all pages. */
export interface SubnameSource {
  /** Full subnames (e.g. "alice.iitr.eth"); 'not_found' when the parent has no domain entity. */
  listChildren(parent: string): Promise<string[] | 'not_found'>;
}

/**
 * `cause` of an unavailable hand-off (SQ-A-06, F-9): 'server_error' for a 5xx answer, 'timeout' when no answer came
 * back (timeout or network failure: whether the wallet got the envelope is unknown).
 */
export type UnavailableCause = 'timeout' | 'server_error';

export type SubmitResult =
  { status: 'accepted' } | { status: 'rejected'; message: string } | { status: 'unavailable'; cause: UnavailableCause };

/** §14.2 POST {execution.url}/v1/intents with Idempotency-Key. */
export interface ExecutionClient {
  submit(envelope: HandoffEnvelope, idempotencyKey: string): Promise<SubmitResult>;
}

export type FetchResult =
  | { ok: true; text: string }
  /** Any failure: non-https, redirect off https, private host, timeout, too big, bad content type. */
  | { ok: false };

/** §8.2 step 3: HTTPS GET with SSRF + size rules; returns extracted text (html-to-text / pdf-parse / plain). */
export interface ContentFetcher {
  fetchUrl(url: string): Promise<FetchResult>;
}

// ───────────────────────────── §18 logger ─────────────────────────────

/** The only fields a log line may carry (§18). `ts` and `level` are added by the logger. */
export interface LogFields {
  session_id?: string;
  request_id?: string;
  step?: string;
  state?: string;
  event: string;
  error_code?: string;
  question_code?: string;
  attempt?: number;
  llm_call?: 'amounts' | 'request_type' | 'spans' | 'payments' | 'quarantine';
  llm_retry?: boolean;
  duration_ms?: number;
  n_amounts?: number;
  n_payees?: number;
  n_intents?: number;
  rule_id?: string;
  chain_ids_unavailable?: number[];
  http_status?: number;
}

export const LOG_ALLOWED_FIELDS: readonly string[] = [
  'ts',
  'level',
  'session_id',
  'request_id',
  'step',
  'state',
  'event',
  'error_code',
  'question_code',
  'attempt',
  'llm_call',
  'llm_retry',
  'duration_ms',
  'n_amounts',
  'n_payees',
  'n_intents',
  'rule_id',
  'chain_ids_unavailable',
  'http_status',
];

export interface AllowlistLogger {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}
