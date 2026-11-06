// Implements: §3.3 fixed state machine (step contract), §8 step boundaries, §9.7 attempt counting contract,
// §17.3 pause/resume. Owned by the Orchestrator (frozen contract).
//
// Runner semantics (Lane A implements, every step relies on them):
//  - Steps run S0 → S12 in order through src/pipeline/registry.ts. S0–S2 run only for new messages.
//  - Step returns 'continue'         → runner moves to the NEXT step.
//  - Step returns 'question'         → runner sets req.paused_at = { step, question }, replies awaiting_answer.
//  - AnswerHandler gets the answer for the step that asked. Its result:
//      'question' with the same code and attempt+1 → re-ask (runner ends with TOO_MANY_RETRIES when
//                                                     attempt would exceed max_attempts = 4, §9.7);
//      'question' (any other)                     → pause again on this step;
//      'continue'                                 → runner RE-INVOKES THE SAME STEP function, which must be
//                                                     re-entrant and pick up its progress from req.step_state;
//      'error' / 'discard' / 'answer' / 'summary' → as below.
//  - 'answer'  → request ANSWERED, messages returned (balance answer, refusals that are answers).
//  - 'summary' → only S11; request AWAITING_CONFIRMATION.
//  - 'error'   → request FAILED (or `final_state` when given, e.g. ANSWERED for S4 unsupported §8.5 rule 1).
//               S12 returning EXECUTION_UNAVAILABLE → runner sets HANDOFF_FAILED (§8.14 step 6).
//  - 'discard' → request DISCARDED (e.g. Q_ENS_CHANGED "Cancel", Q_LIMIT_OVERRIDE "No").

import type { DateTime } from 'luxon';
import type { AllowlistLogger, ContentFetcher, EnsClient, ExecutionClient, RpcClients, SubnameSource } from './io.js';
import type { LlmClient } from './llm.js';
import type { Repos } from './repos.js';
import type {
  AgentRequest,
  Answer,
  Config,
  ErrorCode,
  Limits,
  Question,
  StepNameRef,
  Summary,
  Token,
} from './types.js';

export type StepName = StepNameRef;

export const STEP_ORDER: readonly StepName[] = [
  's0',
  's1',
  's2',
  's3',
  's4',
  's5',
  's6',
  's7',
  's8',
  's9',
  's10',
  's11',
  's12',
];

export type StepResult =
  | { kind: 'continue' } // go to the next step (from a Step) / re-enter this step (from an AnswerHandler)
  | { kind: 'question'; question: Question } // pause; resume this step with the answer
  | { kind: 'answer'; messages: string[] } // request ends with a reply (balance, refusal)
  | { kind: 'summary'; summary: Summary } // S11: wait for confirmation
  | {
      kind: 'error';
      code: ErrorCode;
      params?: Record<string, string>;
      /** Defaults to 'FAILED'. 'ANSWERED' for refusals (§15 intro, §8.5 rule 1). */
      final_state?: 'FAILED' | 'ANSWERED';
    }
  | { kind: 'discard'; messages?: string[] }; // request DISCARDED

export interface StepContext {
  req: AgentRequest;
  repos: Repos; // §5.3
  llm: LlmClient; // §5.4
  rpc: RpcClients; // §5.5
  ens: EnsClient; // §5.5
  subnames: SubnameSource; // §5.5
  exec: ExecutionClient; // §5.5
  fetcher: ContentFetcher; // §5.5
  config: Config;
  limits: Limits; // DB5 snapshot for this request
  now: () => DateTime; // session timezone
  timezone: string; // session IANA timezone
  log: AllowlistLogger;
}

export type Step = (ctx: StepContext) => Promise<StepResult>;
// Called when the pending question of this step is answered. Must validate the answer (spec §13.4)
// and return either the same question with attempt+1, a new question, or continue/error.
export type AnswerHandler = (ctx: StepContext, q: Question, answer: Answer) => Promise<StepResult>;

export interface StepEntry {
  step: Step;
  onAnswer?: AnswerHandler;
}

// ───────────────────────────── Cross-lane shared functions (signatures) ─────────────────────────────
// Implementations live in the owning lane's directory; at contracts-v1 they are stubs.

/** Lane A — src/util/ids.ts (§7.3). */
export type IdKind = 'request' | 'autopay' | 'session' | 'question';
export type PlaceholderKind = 'amount' | 'address' | 'group';
export type NewId = (kind: IdKind) => string;
export type NewPlaceholder = (kind: PlaceholderKind) => string;

/** Lane B — src/amounts/parse.ts (§8.4 step 3 code parser; also used for every number answer, §13.4). */
export type ParsedAmount =
  | { ok: true; value: string } // canonical decimal string, no trailing zeros
  | { ok: false; reason: 'unparseable' | 'zero' | 'precision' };
export type ParseAmountText = (text: string, token: Token | null) => ParsedAmount;

/** Lane D — src/messages/balance.ts (§13.2). Lane B's S4 calls it for balance answers and also_balance. */
export type BuildBalanceAnswer = (ctx: StepContext) => string[];
