// What each intent type plugs into the runner. The runner owns the lifecycle that keeps money safe: approve, prepare, save
// the signed transaction, send, confirm. A handler only says what to send, and what success looks like.

import type { SmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import type { Hex } from 'viem';
import type { ChainGateway, TxReceipt, TxRequest } from '../chain/gateway.js';
import type { Check } from '../guard/check.js';
import type { EnvelopeIntent, HandoffEnvelope } from '../schemas/envelope.js';
import type { StepResult, Store } from '../store/store.js';

export interface Deployment {
  executor: Hex;
  deploymentBlock: number;
  env: SmartAccountsEnvironment;
}

export interface StepOutcome extends StepResult {
  /** Saved in the same transaction as the outcome. */
  commit?: (store: Store) => void;
}

export interface HandlerContext {
  store: Store;
  walletAddress: Hex;
  envelope: HandoffEnvelope;
  gateway: ChainGateway;
  gatewayFor: (chainId: number) => ChainGateway;
  deploymentFor: (chainId: number) => Deployment | null;
  now: () => Date;
  bridgeTimeoutMs: number;
  bridgeFeeMaxEth?: string;
}

/** What to check before asking the user. `finished` means there's nothing to sign. */
export type Planned = { kind: 'check'; check: Check } | { kind: 'finished'; outcome: StepOutcome };

export type Prepared = { kind: 'tx'; tx: TxRequest } | { kind: 'finished'; outcome: StepOutcome };
export type Settled = { kind: 'finished'; outcome: StepOutcome } | { kind: 'wait'; data: unknown };

export const finished = (outcome: StepOutcome): { kind: 'finished'; outcome: StepOutcome } => ({
  kind: 'finished',
  outcome,
});

export interface StepHandler<I extends EnvelopeIntent = EnvelopeIntent> {
  chainOf(intent: I): number;
  /** Runs before approval, and signs nothing. Says what the decoder and simulation must see. */
  plan(ctx: HandlerContext, intent: I): Promise<Planned>;
  /** Runs after approval. Sends nothing. May save what it must reuse after a crash. */
  prepare(ctx: HandlerContext, intent: I): Promise<Prepared>;
  /** The transaction succeeded on chain. Decides whether it did what it should. */
  settled(ctx: HandlerContext, intent: I, receipt: TxReceipt, hash: Hex): Promise<Settled>;
  /** Only for handlers that wait. Null means keep waiting. */
  poll?(ctx: HandlerContext, intent: I, data: unknown, hash: Hex): Promise<StepOutcome | null>;
  /** §14.3 fields that every report for this intent carries, including a failure before anything was sent. */
  baseReport?(intent: I): Record<string, unknown>;
}
