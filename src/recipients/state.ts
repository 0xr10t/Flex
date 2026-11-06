// Implements: §9.7 (one question at a time, in payee order; attempt counting) — the resumable S6 progress kept in
// `req.step_state.s6` (contracts step.ts: an AnswerHandler returning `continue` re-enters S6, which resumes here).

import type { Address, AgentRequest, ChainId, GroupPh, Question, Span } from '../contracts/types.js';
import type { ChainAddress } from './ens.js';
import type { MemberLookup } from './group.js';

/** Where the payee being resolved came from; carried through every sub-flow. */
export interface Origin {
  /** The span text (or Q_NO_PAYEE answer). */
  text: string;
  /** "{ for name}" in Q_ADDRESS_REENTER and the Q_NAME_FOR_ADDRESS prefill (§9.1 step 4: the original span text). */
  suggested: string | null;
  /** Document payee (§8.6 step 8): content wording + "Don't pay this one" (§9.2 step 5). */
  untrusted: boolean;
  /** Clause of the span in the lexical scan, for §9.3 step 3 / §9.6 step 2; null when not from typed text. */
  clause_index: number | null;
}

/** ENS context of an address being confirmed (§9.3 step 7). */
export interface EnsInfo {
  name: string;
  /** Chains whose record returned this address. */
  chain_ids: ChainId[];
  /** Chain chosen in Q_ENS_CHAIN (§9.3 step 6). */
  pinned: ChainId | null;
}

export type Flow =
  /** Q_WHO_IS pending (§9.1 step 4). */
  | { t: 'who_is'; origin: Origin }
  /** §9.2 address flow; `stage` names the pending question, whose attempt counts the "No, re-enter" loop (§9.7). */
  | {
      t: 'addr';
      stage: 'correct' | 'reenter' | 'name';
      address: Address | null;
      ens: EnsInfo | null;
      origin: Origin;
    }
  /** Q_ENS_CHAIN pending (§9.3 step 6). */
  | { t: 'ens_chain'; name: string; found: ChainAddress[]; origin: Origin; attempt: number }
  /** Q_ENS_CHANGED pending (§9.4). `fresh` null = "no address now" variant. */
  | { t: 'ens_changed'; name_key: string; ens: string; saved: Address; fresh: Address | null }
  /** §9.6 group flow; `stage` names the pending question. */
  | {
      t: 'group';
      stage: 'parent' | 'chain' | 'members';
      /** Normalised parent, null while it has to be asked. */
      parent: string | null;
      chain_id: ChainId | null;
      /** Attempt for the next Q_GROUP_PARENT ask (a parent the user typed that isn't in ENS counts as a failure). */
      parent_attempt: number;
      members: MemberLookup[];
      self: string[];
      origin: Origin;
    }
  /** Q_NO_PAYEE pending after every document payee was dropped (§9.2 step 5). */
  | { t: 'no_payee' };

export interface S6State {
  /** Index into req.spans of the payee being resolved; req.resolved holds entries for 0 … index−1. */
  index: number;
  /** Payees removed with "Don't pay this one". */
  removed: number;
  /**
   * The removed payees' texts and typed ranges (in masked_text_s3, null for a document payee): S7 masks them as
   * `[person]` so a removed payee never reaches LLM #4 (§16.1, §8.8).
   */
  removed_spans: Array<{ text: string; span: Span | null }>;
  /**
   * Lower-cased addresses written to DB2 during this request (add_contact, §9.4 "Use new address"). For a document
   * payee only DB2 rows that existed before the request count as saved contacts (§9.2 step 7, §16.1, R3-1).
   */
  added: string[];
  flow: Flow | null;
  /** The question currently asked and its text without any re-ask hint. */
  pending: { question: Question; base_text: string } | null;
  /** Group placeholders written in §9.6 step 10, keyed by resolved index (S7 reuses them, §8.8). */
  groups: Record<number, GroupPh>;
  done: boolean;
}

export function s6State(req: AgentRequest): S6State {
  const cur = req.step_state.s6 as S6State | undefined;
  if (cur) {
    cur.removed_spans ??= [];
    cur.added ??= [];
    return cur;
  }
  const fresh: S6State = {
    index: 0,
    removed: 0,
    removed_spans: [],
    added: [],
    flow: null,
    pending: null,
    groups: {},
    done: false,
  };
  req.step_state.s6 = fresh;
  return fresh;
}
