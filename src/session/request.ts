// Implements: §8.0 the in-memory request object (fresh request per user message), RequestState progression per
// step (§3.3 / §8.0 state names), terminal states. Owner: Lane A.

import type { StepName } from '../contracts/step.js';
import type {
  AgentRequest,
  LexicalScan,
  MessageInput,
  RequestId,
  RequestState,
  SessionId,
} from '../contracts/types.js';

/** State a request reaches when the step returns `continue` (§8.0 state names, in step order). */
export const STATE_AFTER_STEP: Readonly<Record<StepName, RequestState>> = {
  s0: 'BALANCES_REFRESHED',
  s1: 'GUARDED',
  s2: 'SCANNED',
  s3: 'AMOUNTS_MASKED',
  s4: 'TYPED',
  s5: 'SPANS_TAGGED',
  s6: 'RECIPIENTS_RESOLVED',
  s7: 'RECIPIENTS_MASKED',
  s8: 'PAIRED',
  s9: 'PLANNED',
  s10: 'VALIDATED',
  s11: 'AWAITING_CONFIRMATION',
  s12: 'HANDED_OFF',
};

/** Every §8.0 request state (the record makes the compiler check the list is complete). */
export const REQUEST_STATES: readonly string[] = Object.keys({
  RECEIVED: true,
  BALANCES_REFRESHED: true,
  GUARDED: true,
  SCANNED: true,
  AMOUNTS_MASKED: true,
  TYPED: true,
  SPANS_TAGGED: true,
  RECIPIENTS_RESOLVED: true,
  RECIPIENTS_MASKED: true,
  PAIRED: true,
  PLANNED: true,
  VALIDATED: true,
  AWAITING_CONFIRMATION: true,
  HANDED_OFF: true,
  HANDOFF_FAILED: true,
  ANSWERED: true,
  DISCARDED: true,
  FAILED: true,
} satisfies Record<RequestState, true>);

/** States after which a request accepts no further input. */
export const TERMINAL_STATES: ReadonlySet<RequestState> = new Set<RequestState>([
  'ANSWERED',
  'HANDED_OFF',
  'DISCARDED',
  'FAILED',
]);

export const isTerminal = (req: AgentRequest): boolean => TERMINAL_STATES.has(req.state);

/** Paused on a question (§13.4) and not finished. */
export const isAwaitingAnswer = (req: AgentRequest): boolean => !isTerminal(req) && req.paused_at !== undefined;

export function emptyScan(): LexicalScan {
  return {
    clauses: [],
    addresses: [],
    ens: [],
    groups: [],
    chains: [],
    tokens: [],
    dates: [],
    recurrence: [],
    cancel: [],
    back_reference: [],
    distributive: [],
    split: [],
    numeric_candidates: [],
  };
}

/** A fresh request for one user message (§8.0). `typed_text` is set by S1 after URL removal. */
export function newAgentRequest(request_id: RequestId, session_id: SessionId, input: MessageInput): AgentRequest {
  return {
    request_id,
    session_id,
    state: 'RECEIVED',
    typed_text: '',
    untrusted: [],
    scan: emptyScan(),
    amounts: [],
    spans: [],
    recipients: [],
    notes: [],
    limit_override: false,
    handoff_attempts: 0,
    input,
    resolved: [],
    mentioned_spans: [],
    prepend_messages: [],
    step_state: {},
  };
}
