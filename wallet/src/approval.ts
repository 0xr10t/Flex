// Implements: OQ-01 (the user approves each payment in the wallet, then the wallet signs). How the user is asked is OQ-02,
// which is still open, so this is the seam a real approval screen plugs into.

import type { EnvelopeIntent, HandoffEnvelope } from '@flex/protocol/schemas/envelope';

export interface ApprovalRequest {
  envelope: HandoffEnvelope;
  intent: EnvelopeIntent;
  /**
   * What the decoder read from the bytes about to be signed. Privacy fix 2: the simulation runs after approval, so a
   * refused request never reaches the RPC; nothing is signed unless the simulation then matches too.
   */
  summary: string[];
}

export interface Approver {
  approve(request: ApprovalRequest): Promise<boolean>;
}

/** The safe default until OQ-02 is decided: nothing is signed, and each step is reported as failed. */
export const rejectAll: Approver = { approve: async () => false };

/** Signs everything without asking. Only for local chains and testnets, and only when explicitly configured. */
export const autoApprove: Approver = { approve: async () => true };
