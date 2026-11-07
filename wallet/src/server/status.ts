// What happened to each step of one request, for the CLI that handed it off: GET /v1/intents/:request_id.
//
// The terminal states come from the store. "confirmed" also reads the transaction's receipt, so a transfer shows as
// gone through as soon as its block is mined. Before this, only a finalized result was reported, which takes ~15 min.
// A receipt is cached once found. A reverted receipt is reported as failed now; the runner records the same outcome
// once that block is final.

import type { Hex } from 'viem';
import type { HandoffEnvelope } from '@flex/protocol/schemas/envelope';
import { pendingDelegations } from '../browser/delegation.js';
import { awaitingAccountUpgrade } from '../browser/upgrade.js';
import type { Store } from '../store/store.js';

export type StepState =
  /** The wallet is still checking and preparing it. */
  | 'preparing'
  /** The account needs the MetaMask smart-account upgrade on this chain first. */
  | 'needs_setup'
  /** Waiting for the user to approve or reject it in MetaMask. */
  | 'awaiting_approval'
  /** Sent; its block is not mined yet. */
  | 'confirming'
  /** Mined and successful; finality (and, for a bridge, delivery) still to come. */
  | 'confirmed'
  /** Final: delivered and verified. */
  | 'completed'
  | 'failed';

export interface StepView {
  step: number;
  kind: 'i' | 'j' | 'k' | 'l';
  chain_id: number;
  dest_chain_id?: number;
  token?: string;
  recipients?: { address: Hex; amount: string }[];
  amount?: string;
  state: StepState;
  tx_hash: Hex | null;
  error_code: string | null;
}

export type ReceiptStatus = (chainId: number, hash: Hex) => Promise<'success' | 'reverted' | null>;

const describe = (intent: HandoffEnvelope['intents'][number]) => {
  switch (intent.intent_id) {
    case 'i':
    case 'k':
      return {
        kind: intent.intent_id,
        chain_id: intent.chain_id,
        token: intent.token,
        recipients: intent.recipients.map((r) => ({ address: r.recipient, amount: r.amount.value })),
      };
    case 'j':
      return {
        kind: 'j' as const,
        chain_id: intent.source_chain_id,
        dest_chain_id: intent.dest_chain_id,
        token: intent.token,
        amount: intent.amount.value,
      };
    case 'l':
      return { kind: 'l' as const, chain_id: intent.chain_id };
  }
};

export function statusReader(store: Store, receipt: ReceiptStatus) {
  const mined = new Map<Hex, 'success' | 'reverted'>();
  const lookup = async (chainId: number, hash: Hex) => {
    const known = mined.get(hash);
    if (known) return known;
    try {
      const status = await receipt(chainId, hash);
      if (status) mined.set(hash, status);
      return status;
    } catch {
      // The chain did not answer: say "confirming" and ask again on the next poll.
      return null;
    }
  };

  return async (requestId: string): Promise<{ request_id: string; steps: StepView[] } | null> => {
    const envelope = store.envelope(requestId);
    if (!envelope) return null;
    const rows = new Map(store.stepsOf(requestId).map((row) => [row.step, row]));
    const signing = new Set(
      pendingDelegations(store)
        .filter((d) => d.requestId === requestId)
        .map((d) => d.step),
    );
    const steps = await Promise.all(
      envelope.intents.map(async (intent): Promise<StepView> => {
        const row = rows.get(intent.step);
        const about = describe(intent);
        const batch = store.walletBatch(requestId, intent.step);
        const hash = row?.tx_hash ?? (batch?.status === 'received' ? batch.tx_hash : null);
        const view = (state: StepState, error: string | null = null): StepView => ({
          step: intent.step,
          ...about,
          state,
          tx_hash: hash,
          error_code: error,
        });
        if (!row) return view('preparing');
        if (row.status === 'executed') return view('completed');
        if (row.status === 'failed') return view('failed', row.error_code);
        if (batch?.status === 'rejected') return view('failed', 'USER_REJECTED');
        if (row.status === 'waiting') return view('confirmed');
        if (hash) {
          const status = await lookup(about.chain_id, hash);
          if (status === 'reverted') return view('failed', 'TX_REVERTED');
          return view(status === 'success' ? 'confirmed' : 'confirming');
        }
        if (awaitingAccountUpgrade(row)) return view('needs_setup');
        if (signing.has(intent.step) || batch?.status === 'draft' || batch?.status === 'dispatched')
          return view('awaiting_approval');
        return view('preparing');
      }),
    );
    return { request_id: requestId, steps };
  };
}
