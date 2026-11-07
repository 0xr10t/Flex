// Implements: §17.1 session lifecycle (one open session, opening closes the previous one, close clears DB1/DB3/DB8
// via §7.4 and abandons an in-progress request as DISCARDED, no idle timeout), §8.0 one active request per session
// kept in memory, §3.3 fixed step order run through the injected registry (runner semantics of
// src/contracts/step.ts: S0–S2 only for new messages, pause/resume on questions, `continue` from an AnswerHandler
// re-enters the same step), §9.7 / §13.4 max_attempts 4 → TOO_MANY_RETRIES, §17.3 confirmation/answer/cancel
// table, §8.14 step 6 / I-37 HANDOFF_FAILED retried up to 3 attempts in total, §13.3 fixed replies, §14.1
// AgentResponse, §14.4 MODEL_FAILED when the model is unavailable, §15 error responses, §0 / SQ-19 uncovered states
// → UNSUPPORTED_REQUEST with an `unsupported_state` log line (SQ-A-03 message while HANDOFF_FAILED), SQ-A-01 / F-8
// cancel without a cancellable request, SQ-A-06 / F-9 final hand-off text by cause, §18 metrics as log events.
// SQ-S-01 / SQ-S-02: retain an unsubmitted failed payment for the next follow-up, without adding DB8 history.
// SQ-CHAT-02: read-only wallet answers use session memory and local stores, preserving the active payment state.
// Owner: Lane A.

import { DateTime, IANAZone } from 'luxon';
import { getAddress } from 'viem';
import { ERROR_MESSAGE, REPLY, matchChip } from '../contracts/catalog.js';
import type {
  AllowlistLogger,
  ContentFetcher,
  EnsClient,
  ExecutionClient,
  RpcClients,
  SubnameSource,
} from '../contracts/io.js';
import { LlmFailed, type LlmClient } from '../contracts/llm.js';
import type { Repos } from '../contracts/repos.js';
import {
  STEP_ORDER,
  type NewId,
  type StepContext,
  type StepEntry,
  type StepName,
  type StepResult,
} from '../contracts/step.js';
import type {
  AgentRequest,
  Address,
  AgentResponse,
  Answer,
  Config,
  ErrorCode,
  FailedPaymentContext,
  Limits,
  MessageInput,
  RequestId,
  ResponseState,
  SessionId,
} from '../contracts/types.js';
import { MAX_PLACEHOLDER_DRAWS } from '../db/repos/common.js';
import { detectSecret } from '../guard/secrets.js';
import { extractUrls, urlHasSecret } from '../guard/urls.js';
import { newId as defaultNewId } from '../util/ids.js';
import { isAwaitingAnswer, isTerminal, newAgentRequest, STATE_AFTER_STEP } from './request.js';
import { classifyConfirmationText, isCancelText } from './texts.js';
import { failedPaymentContext } from './failed-payment.js';
import { prepareDraftCorrection } from './draft-correction.js';
import {
  answerOnlyReply,
  explicitDraftCancellation,
  interpretReply,
  literalRecipientAddress,
  needsConversation,
  recipientOnlyReply,
  replyGuidance,
  simpleRecipient,
  type ConversationTurn,
} from './conversation.js';
import { canCorrectPendingRecipient, correctPendingRecipient } from '../recipients/resolve.js';
import {
  ChatInputTooLong,
  classifyChatMessage,
  generateChatReply,
  generateWalletReply,
  rememberChat,
  type ChatContext,
  type ChatTurn,
} from './general-chat.js';
import { buildWalletContext } from './wallet-context.js';
import { parseWalletQuery, renderWalletQuery } from './wallet-query.js';
import type { HistoryReader } from '../history/types.js';
import { parseReceivedQuery, renderReceivedQuery } from './received-query.js';
import { explainIdentifierQuery } from './identifier-query.js';
import { lexicalScan } from '../lexical/scan.js';
import { isPaymentRequest, isTransactionStatusQuery, readTransactionStatus } from './transaction-status.js';

/** §13.4 `max_attempts`. */
export const MAX_ATTEMPTS = 4;
/** §8.14 step 6: hand-off attempts in total. */
export const MAX_HANDOFF_ATTEMPTS = 3;

export type StepRegistry = Readonly<Record<StepName, StepEntry>>;

export interface SessionManagerDeps {
  repos: Repos;
  llm: LlmClient;
  rpc: RpcClients;
  /** Informational account history, refreshed independently of requests. Never a signing authority. */
  history?: HistoryReader;
  ens: EnsClient;
  subnames: SubnameSource;
  exec: ExecutionClient;
  fetcher: ContentFetcher;
  log: AllowlistLogger;
  config: Config;
  /** The step registry (src/pipeline/registry.ts in production; stub steps in tests). */
  registry: StepRegistry;
  /** Current instant (default: system clock). Steps get it in the session timezone via `ctx.now`. */
  clock?: () => DateTime;
  newId?: NewId;
}

/** Outcome of a session call: a body, or the HTTP condition the route maps to 404 / 409. */
export type SessionResult<T = AgentResponse> = { kind: 'ok'; body: T } | { kind: 'not_found' } | { kind: 'conflict' };

/** Body of POST /v1/sessions/{id}/answers (§14.1). */
export type AnswerBody =
  | { question_id: string; chip_id: string }
  | { question_id: string; text: string }
  | { question_id: string; selected_ids: string[] };

interface Active {
  req: AgentRequest;
  /** DB5 snapshot taken when the request started (StepContext.limits). */
  limits: Limits;
  /** SQ-R-06: cause of the last failed hand-off attempt ('timeout' | 'server_error'). */
  lastHandoffCause?: string;
  /** SQ-S-01: consumed by the next message, cleared on cancellation; never persisted. */
  failedPayment?: FailedPaymentContext;
  /** SQ-CV-01: bounded, guarded user replies for the current draft only; cleared with its in-memory state. */
  conversation?: ConversationTurn[];
  /** The native error is retained for chat context and the hand-off retry UI; it is never model-authored. */
  lastError?: AgentResponse['error'];
}

interface OpenSession {
  session_id: SessionId;
  /** Public account captured when this session opens; replaced on wallet reconnection. */
  walletAddress: Address;
  timezone: string;
  active: Active | null;
  /** The last payment survives unrelated balance/unsupported requests, only within this session. */
  lastPayment: Active | null;
  /** Opt-in generic exchanges only, bounded by rememberChat; never persisted or used as wallet answers. */
  chatHistory: ChatTurn[];
  /** Sticky until close so a follow-up knows that older generic exchanges have been dropped. */
  chatHistoryOmitted: boolean;
  /** §14.1: one call per session at a time. */
  busy: boolean;
  /** The call in progress (R1-F1: closing the session waits for it). */
  inflight: Promise<unknown> | null;
  /** Set when a close has started: new calls get 404 while the close waits for the call in progress. */
  closing: boolean;
  closed: boolean;
}

/** Thrown out of a run when the session was closed while a step was awaiting (§17.1: request abandoned). */
class SessionClosed extends Error {}

const ok = <T>(body: T): SessionResult<T> => ({ kind: 'ok', body });
const NOT_FOUND = { kind: 'not_found' } as const;
const CONFLICT = { kind: 'conflict' } as const;

/** §14.4: the configured model is available; a client that throws counts as unavailable. */
export async function modelReady(llm: LlmClient): Promise<boolean> {
  try {
    return await llm.modelAvailable();
  } catch {
    return false;
  }
}

/** An instant as the ISO-8601 UTC string stored in the DB (§7). */
/** True when the text asks to pay the members of an ENS name (S2 rule 4's group markers). */
function namesEnsGroup(text: string, chains: Config['chains'], now: DateTime): boolean {
  const scan = lexicalScan(text, { chains, now });
  return scan.ok && scan.scan.groups.length > 0;
}

export const toIsoUtc = (t: DateTime): string => t.toUTC().toISO() ?? new Date().toISOString();

export class SessionManager {
  private readonly deps: SessionManagerDeps;
  private readonly clock: () => DateTime;
  private readonly newId: NewId;
  private open: OpenSession | null = null;
  private lifecycle: Promise<unknown> = Promise.resolve();

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => DateTime.utc());
    this.newId = deps.newId ?? defaultNewId;
  }

  // ───────────────────────────── sessions (§17.1) ─────────────────────────────

  /**
   * POST /v1/sessions: closes any open session (clearing DB1/DB3/DB8), opens a new one. R1-F1: a call still running
   * in the open session (e.g. S12 awaiting the execution layer) is waited for first, so it ends as it would have and
   * the close then treats its request as usual (a HANDED_OFF request is never turned into DISCARDED).
   */
  async openSession(timezone: string): Promise<{ session_id: SessionId }> {
    if (!IANAZone.isValidZone(timezone)) throw new Error('invalid timezone');
    // The open session is going away: from now on its new calls get 404 (also while the close waits).
    if (this.open !== null) this.open.closing = true;
    return this.serialized(async () => {
      if (this.open !== null) await this.closeOpen(this.open);
      const opened_at = this.nowIso();
      for (let i = 0; i < MAX_PLACEHOLDER_DRAWS; i++) {
        const session_id = this.newId('session') as SessionId;
        if (this.deps.repos.db8.getSession(session_id) !== undefined) continue;
        this.deps.repos.db8.insertSession({ session_id, timezone, opened_at });
        this.open = {
          session_id,
          walletAddress: getAddress(this.deps.config.wallet.address),
          timezone,
          active: null,
          lastPayment: null,
          chatHistory: [],
          chatHistoryOmitted: false,
          busy: false,
          inflight: null,
          closing: false,
          closed: false,
        };
        this.deps.log.info({ event: 'session_opened', session_id });
        return { session_id };
      }
      throw new Error('session id collision');
    });
  }

  /**
   * DELETE /v1/sessions/{id}: closes the session and clears DB1, DB3, DB8 (§7.4). Returns false for an unknown id.
   * Waits for a call still running in that session first (R1-F1).
   * A session left in DB8 by a crashed process can be closed too (ADR-007), unless another session is open: the clear
   * would delete that session's rows, so the id counts as unknown and the next close wipes it (SQ-A-05).
   */
  async closeSession(session_id: string): Promise<boolean> {
    if (this.open !== null && this.open.session_id === session_id) this.open.closing = true;
    return this.serialized(async () => {
      if (this.open !== null && this.open.session_id === session_id) {
        await this.closeOpen(this.open);
        return true;
      }
      if (this.open === null && this.deps.repos.db8.getSession(session_id) !== undefined) {
        this.deps.repos.clearSessionStores();
        this.deps.log.info({ event: 'session_closed', session_id });
        return true;
      }
      return false;
    });
  }

  /** The open session id, if any (one at a time, I-08). */
  openSessionId(): SessionId | null {
    return this.open?.session_id ?? null;
  }

  /** Session opens and closes run one after another (each may wait for a call in progress). */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(fn, fn);
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  private async closeOpen(s: OpenSession): Promise<void> {
    s.closing = true;
    // R1-F1: let the call in progress finish (its writes and its response) before the request is judged and cleared.
    while (s.inflight !== null) await s.inflight.catch(() => undefined);
    s.closed = true;
    if (this.open === s) this.open = null;
    const a = s.active;
    if (a !== null && !isTerminal(a.req)) this.markDiscarded(a.req);
    s.active = null;
    s.lastPayment = null;
    s.chatHistory = [];
    s.chatHistoryOmitted = false;
    this.deps.repos.clearSessionStores();
    this.deps.log.info({ event: 'session_closed', session_id: s.session_id });
  }

  // ───────────────────────────── calls (§14.1, §17.3) ─────────────────────────────

  /** POST /v1/sessions/{id}/messages: a new request, or an answer/confirmation per §17.3. */
  async handleMessage(session_id: string, input: MessageInput): Promise<SessionResult> {
    return this.exclusive(session_id, async (s) => {
      const local = this.localWalletReply(s, input);
      if (local !== null) return ok({ ...local, reply_source: 'local' });
      // SQ-CV-02: interpret an explicit edit against the validated draft before generic chat or replacement.
      // A fresh request identity prevents a confirmation for the old summary from approving its revision.
      const pending = s.active;
      if (pending?.req.state === 'AWAITING_CONFIRMATION' && classifyConfirmationText(input.text) === 'other') {
        const correction = await prepareDraftCorrection(this.context(s, pending), input);
        this.assertOpen(s);
        if (correction?.kind === 'clarify') return ok(this.chatReply(s, pending, correction.message));
        if (correction?.kind === 'chat') {
          const chat = await this.generalChat(s, input);
          return ok(
            chat ?? this.chatReply(s, pending, 'Your draft is still open. Review its summary before confirming.'),
          );
        }
        if (correction?.kind === 'replace') {
          this.markDiscarded(pending.req);
          return ok(
            await this.newRequest(s, correction.input, ['I updated your draft. Please review the revised summary.']),
          );
        }
        if (correction?.kind === 'new_request') {
          this.markDiscarded(pending.req);
          return ok(await this.newRequest(s, input, [REPLY.PENDING_REPLACED()]));
        }
      }
      if (this.deps.config.chat?.enabled) {
        const chat = await this.generalChat(s, input);
        if (chat !== null) return ok(chat);
      }
      const a = s.active;
      if (a?.failedPayment !== undefined && isCancelText(input.text)) {
        delete a.failedPayment;
        return ok(this.noopReply(s, a.req.request_id, REPLY.CANCELLED()));
      }
      if (a !== null && isAwaitingAnswer(a.req)) {
        // SQ-CV-01 supersedes §17.3's unconditional field-answer routing for conversational replies.
        if (isCancelText(input.text)) return ok(this.discard(s, a, REPLY.CANCELLED()));
        return ok(await this.answer(s, a, { kind: 'text', text: input.text }, input));
      }
      if (a !== null && a.req.state === 'AWAITING_CONFIRMATION') {
        switch (classifyConfirmationText(input.text)) {
          case 'cancel':
            return ok(this.discard(s, a, REPLY.CANCELLED()));
          case 'yes':
            return ok(await this.handoff(s, a));
          case 'no':
            return ok(this.discard(s, a, REPLY.USER_SAID_NO()));
          case 'other': {
            // §17.3: the pending request is DISCARDED; the text starts a new request with the §13.3 line prepended.
            this.markDiscarded(a.req);
            return ok(await this.newRequest(s, input, [REPLY.PENDING_REPLACED()]));
          }
        }
      }
      if (a !== null && a.req.state === 'HANDOFF_FAILED') {
        // §17.3 has no row for a messages call while HANDOFF_FAILED (SQ-A-03). Interim: cancel
        // texts cancel it like the cancel endpoint; any other text → UNSUPPORTED_REQUEST (§0) and the request stays
        // HANDOFF_FAILED, so `confirm` yes can still retry it.
        if (isCancelText(input.text)) return ok(this.discard(s, a, this.cancelText(a)));
        this.logUnsupported(s, a.req.state, 'handoff_failed:message', a.req.request_id);
        return ok(this.unsupportedReply(s, a.req.request_id));
      }
      return ok(await this.newRequest(s, input, []));
    });
  }

  /** POST /v1/sessions/{id}/answers. Wrong/stale question_id → 409. */
  async handleAnswer(session_id: string, body: AnswerBody): Promise<SessionResult> {
    return this.exclusive(session_id, async (s) => {
      const a = s.active;
      if (a === null || !isAwaitingAnswer(a.req) || a.req.paused_at?.question.question_id !== body.question_id) {
        return CONFLICT;
      }
      const answer: Answer =
        'chip_id' in body
          ? { kind: 'chip', chip_id: body.chip_id }
          : 'text' in body
            ? { kind: 'text', text: body.text }
            : { kind: 'selected', selected_ids: [...body.selected_ids] };
      // §13.4 "Every question also accepts 'cancel'" (§17.3 cancel texts).
      if (answer.kind === 'text' && isCancelText(answer.text)) return ok(this.discard(s, a, REPLY.CANCELLED()));
      if (answer.kind === 'text') {
        const local = this.localWalletReply(s, { text: answer.text, pasted_blocks: [], attachments: [], urls: [] });
        if (local !== null) return ok({ ...local, reply_source: 'local' });
      }
      if (this.deps.config.chat?.enabled && answer.kind === 'text') {
        const input: MessageInput = { text: answer.text, pasted_blocks: [], attachments: [], urls: [] };
        const chat = await this.generalChat(s, input);
        if (chat !== null) return ok(chat);
        return ok(await this.answer(s, a, answer, input));
      }
      return ok(await this.answer(s, a, answer));
    });
  }

  /** POST /v1/sessions/{id}/confirm: only in AWAITING_CONFIRMATION, or HANDOFF_FAILED with "yes"; else 409. */
  async handleConfirm(session_id: string, request_id: string, decision: 'yes' | 'no'): Promise<SessionResult> {
    return this.exclusive(session_id, async (s) => {
      const a = s.active;
      if (a === null || a.req.request_id !== request_id) return CONFLICT;
      if (a.req.state === 'AWAITING_CONFIRMATION') {
        return ok(decision === 'yes' ? await this.handoff(s, a) : this.discard(s, a, REPLY.USER_SAID_NO()));
      }
      if (a.req.state === 'HANDOFF_FAILED' && decision === 'yes') return ok(await this.handoff(s, a));
      return CONFLICT;
    });
  }

  /**
   * POST /v1/sessions/{id}/cancel: cancels the active request (awaiting an answer, a confirmation, or a hand-off
   * retry) → DISCARDED, reply CANCELLED. Nothing cancellable with this id (no request, wrong id, ended request):
   * `done` with the CANCELLED reply, nothing changed (SQ-A-01); a HANDED_OFF request gets the F-8 reply.
   */
  async handleCancel(session_id: string, request_id: string): Promise<SessionResult> {
    return this.exclusive(session_id, async (s) => {
      const a = s.active;
      if (a?.req.request_id === request_id) delete a.failedPayment;
      const cancellable =
        a !== null &&
        a.req.request_id === request_id &&
        (isAwaitingAnswer(a.req) || a.req.state === 'AWAITING_CONFIRMATION' || a.req.state === 'HANDOFF_FAILED');
      if (cancellable) return ok(this.discard(s, a, this.cancelText(a)));
      const submitted = this.deps.repos.handoffs.get(request_id);
      if (submitted !== undefined) {
        const text =
          submitted.status === 'accepted'
            ? REPLY.CANCEL_AFTER_HANDOFF()
            : submitted.status === 'submitted'
              ? REPLY.CANCEL_AFTER_TIMEOUT()
              : REPLY.CANCELLED();
        return ok(this.noopReply(s, request_id, text));
      }
      // SQ-A-01, F-8: nothing to cancel → HTTP 200, state done, nothing changed, safe to repeat. A request already
      // handed off gets its own reply, also when it is no longer the active request (R1-F3: looked up in
      // db8_history / DB6).
      const handedOff =
        a !== null && a.req.request_id === request_id
          ? a.req.state === 'HANDED_OFF'
          : this.deps.repos.db8.hasHistory(s.session_id, request_id) || this.deps.repos.db6.hasRequest(request_id);
      return ok(this.noopReply(s, request_id, handedOff ? REPLY.CANCEL_AFTER_HANDOFF() : REPLY.CANCELLED()));
    });
  }

  /**
   * Reply to cancelling a cancellable request: SQ-R-06 when its last failed hand-off attempt timed out (the wallet may
   * have received it; also after a SQ-R-05 re-plan that followed it), else CANCELLED.
   */
  private cancelText(a: Active): string {
    return a.lastHandoffCause === 'timeout' ? REPLY.CANCEL_AFTER_TIMEOUT() : REPLY.CANCELLED();
  }

  /** A `done` reply that leaves the active request as it is (SQ-A-01, F-8). */
  private noopReply(s: OpenSession, request_id: string, text: string): AgentResponse {
    return { session_id: s.session_id, request_id, state: 'done', messages: [{ type: 'text', text }] };
  }

  /** No model, RPC, pipeline stages or DB writes for an explicit wallet display request. */
  private localWalletReply(s: OpenSession, input: MessageInput): AgentResponse | null {
    if (input.attachments.length || input.pasted_blocks.length || input.urls.length) return null;
    const allowed = this.deps.repos.db5.getAll().allowed_chain_ids;
    const chains = this.deps.config.chains.filter((chain) => allowed.includes(chain.chain_id));
    const info = { address: s.walletAddress, chains, history: this.deps.history };
    // An explicit identifier explanation inspects bytes locally, before the normal secret rejection. Never retain it
    // in chat memory: even a tx-shaped value may actually be a private key. All payment inputs still pass S1.
    const identifier = explainIdentifierQuery(input.text, info);
    if (identifier !== null) return this.chatReply(s, s.active, identifier);
    if (
      isTransactionStatusQuery(input.text) &&
      detectSecret(input.text) === null &&
      !extractUrls(input.text, []).links.length
    ) {
      const status = this.transactionStatus(s);
      return this.chatReply(s, s.active, [status.summary, ...status.details].join('\n'));
    }
    const received = parseReceivedQuery(input.text);
    if (received !== null && detectSecret(input.text) === null && !extractUrls(input.text, []).links.length) {
      return this.chatReply(
        s,
        s.active,
        renderReceivedQuery(received, { ...info, now: this.clock().setZone(s.timezone) }),
      );
    }
    const query = parseWalletQuery(input.text);
    if (query === null || detectSecret(input.text) !== null || extractUrls(input.text, []).links.length) return null;
    const a = s.active;
    if (
      a !== null &&
      isAwaitingAnswer(a.req) &&
      a.req.paused_at !== undefined &&
      !needsConversation(this.context(s, a), a.req.paused_at.question, input.text)
    )
      return null;
    const wallet = query.balances ? buildWalletContext(this.walletReadContext(s), s.walletAddress) : undefined;
    const reply = renderWalletQuery(query, s.walletAddress, wallet);
    if (this.deps.config.chat?.enabled) {
      const history = rememberChat(s.chatHistory, input.text, reply);
      s.chatHistoryOmitted ||= history.length < s.chatHistory.length + 1;
      s.chatHistory = history;
    }
    return this.chatReply(s, a, reply);
  }

  private walletReadContext(s: OpenSession): StepContext {
    return this.context(s, {
      req: newAgentRequest(this.newId('request') as RequestId, s.session_id, {
        text: '',
        pasted_blocks: [],
        attachments: [],
        urls: [],
      }),
      limits: this.deps.repos.db5.getAll(),
    });
  }

  private transactionStatus(s: OpenSession) {
    const active = s.active;
    const payment = active && (!isTerminal(active.req) || isPaymentRequest(active.req)) ? active : s.lastPayment;
    return readTransactionStatus(payment?.req, {
      repos: this.deps.repos,
      exec: this.deps.exec,
      walletAddress: s.walletAddress,
      chains: this.deps.config.chains,
      lastError: payment?.lastError?.code,
    });
  }

  /**
   * Opt-in explanations are separate from payment interpretation. Only guarded, plain typed text is eligible;
   * a wallet classification returns the entire original input to the unchanged native handlers.
   */
  private async generalChat(s: OpenSession, input: MessageInput): Promise<AgentResponse | null> {
    const settings = this.deps.config.chat;
    if (!settings?.enabled) return null;
    const { text } = input;
    const links = extractUrls(text, input.urls).links;
    // Do not send even an intent classifier secret material or raw URLs. S1 / answer() owns their rejection.
    if (detectSecret(text) !== null || links.some((link) => urlHasSecret(link.url))) return null;
    if (input.attachments.length || input.pasted_blocks.length || input.urls.length || links.length) return null;
    if (!text.trim()) return null;
    // Native confirmation words and literal field answers must never depend on model classification.
    if (classifyConfirmationText(text) !== 'other') return null;
    // Neither does an unmistakable ENS group payment ("pay everyone under iitr.eth"): the small routing model has sent
    // such requests to chat, so the lexical group markers decide before it is asked.
    if (namesEnsGroup(text, this.deps.config.chains, this.clock().setZone(s.timezone))) return null;
    const a = s.active;
    if (
      a !== null &&
      isAwaitingAnswer(a.req) &&
      a.req.paused_at !== undefined &&
      !needsConversation(this.context(s, a), a.req.paused_at.question, text)
    )
      return null;
    const context = this.chatContext(s, a);
    try {
      const intent = await classifyChatMessage(this.deps.llm, text, context, s.chatHistory);
      this.assertOpen(s);
      if (intent === 'wallet') return null;
      if (intent === 'wallet_info') {
        // Even contextual wallet questions use only the background-populated cache, including on a cold start.
        context.wallet = buildWalletContext(this.walletReadContext(s), s.walletAddress);
      }
      const reply = await (intent === 'wallet_info' ? generateWalletReply : generateChatReply)(
        this.deps.llm,
        text,
        context,
        s.chatHistory,
        settings.think,
      );
      this.assertOpen(s);
      const history = rememberChat(s.chatHistory, text, reply);
      s.chatHistoryOmitted ||= history.length < s.chatHistory.length + 1;
      s.chatHistory = history;
      return this.chatReply(s, a, reply);
    } catch (error) {
      this.assertOpen(s);
      // An unavailable/invalid chat response is never reinterpreted as a payment or a field answer.
      return this.chatReply(s, a, error instanceof ChatInputTooLong ? REPLY.CHAT_TOO_LONG() : REPLY.CHAT_UNAVAILABLE());
    }
  }

  /** Session's public wallet address and draft context; balance facts come from the local DB4 cache. */
  private chatContext(s: OpenSession, a: Active | null): ChatContext {
    const wallet_address = s.walletAddress;
    const transaction_status = this.transactionStatus(s).summary;
    if (a === null)
      return { state: 'IDLE', wallet_address, transaction_status, older_chat_omitted: s.chatHistoryOmitted };
    const context: ChatContext = {
      state: isAwaitingAnswer(a.req) ? 'AWAITING_ANSWER' : a.req.state,
      wallet_address,
      transaction_status,
      older_chat_omitted: s.chatHistoryOmitted,
    };
    const text = a.req.typed_text;
    // S1 alone sets typed_text. Recheck here so future call sites cannot pass unguarded context to chat.
    if (text && detectSecret(text) === null && extractUrls(text, []).links.length === 0)
      context.original_request = text;
    if (isAwaitingAnswer(a.req) && a.req.paused_at !== undefined) {
      context.question_code = a.req.paused_at.question.code;
      context.guidance = replyGuidance(this.context(s, a), a.req.paused_at.question);
    }
    if (a.req.state === 'AWAITING_CONFIRMATION' && a.req.summary !== undefined) {
      context.pending_summary = { text: a.req.summary.text, notes: [...a.req.summary.notes] };
    }
    if (a.lastError !== undefined) context.last_error = a.lastError.code;
    return context;
  }

  /** Chat leaves every native field untouched, including failed-payment/back-reference context after completion. */
  private chatReply(s: OpenSession, a: Active | null, text: string): AgentResponse {
    if (a === null || isTerminal(a.req)) return this.noopReply(s, this.newId('request'), text);
    const body = this.noopReply(s, a.req.request_id, text);
    if (isAwaitingAnswer(a.req) && a.req.paused_at !== undefined) {
      body.state = 'awaiting_answer';
      body.question = a.req.paused_at.question;
    } else if (a.req.state === 'AWAITING_CONFIRMATION') {
      body.state = 'awaiting_confirmation';
      body.summary = a.req.summary;
    } else if (a.req.state === 'HANDOFF_FAILED') {
      body.state = 'error';
      body.error = a.lastError ?? {
        code: 'EXECUTION_UNAVAILABLE',
        message: ERROR_MESSAGE.EXECUTION_UNAVAILABLE({}),
      };
    }
    return body;
  }

  /** §0 / SQ-19: an uncovered input is logged with its state and branch id (no request is changed). */
  private logUnsupported(s: OpenSession, state: string | undefined, rule_id: string, request_id?: string): void {
    this.deps.log.warn({
      event: 'unsupported_state',
      session_id: s.session_id,
      ...(request_id !== undefined ? { request_id } : {}),
      ...(state !== undefined ? { state } : {}),
      rule_id,
    });
  }

  /** An UNSUPPORTED_REQUEST response that leaves the active request as it is (SQ-A-01, SQ-A-03). */
  private unsupportedReply(s: OpenSession, request_id: string): AgentResponse {
    return {
      session_id: s.session_id,
      request_id,
      state: 'error',
      messages: [],
      error: { code: 'UNSUPPORTED_REQUEST', message: ERROR_MESSAGE.UNSUPPORTED_REQUEST({}) },
    };
  }

  // ───────────────────────────── runner ─────────────────────────────

  /**
   * §14.1: one call per session at a time (second concurrent call → 409); unknown/closed session, or one being closed,
   * → 404.
   */
  private async exclusive(session_id: string, fn: (s: OpenSession) => Promise<SessionResult>): Promise<SessionResult> {
    const s = this.open;
    if (s === null || s.session_id !== session_id || s.closing) return NOT_FOUND;
    if (s.busy) return CONFLICT;
    s.busy = true;
    const call = fn(s);
    s.inflight = call;
    try {
      return await call;
    } catch (e) {
      if (e instanceof SessionClosed) return NOT_FOUND;
      throw e;
    } finally {
      s.busy = false;
      s.inflight = null;
    }
  }

  private async newRequest(s: OpenSession, input: MessageInput, prepend: string[]): Promise<AgentResponse> {
    const req = newAgentRequest(this.newId('request') as RequestId, s.session_id, input);
    const previous = s.active;
    if (previous && isPaymentRequest(previous.req)) s.lastPayment = previous;
    if (
      previous?.req.state === 'FAILED' &&
      previous.failedPayment !== undefined &&
      input.pasted_blocks.length === 0 &&
      input.attachments.length === 0 &&
      extractUrls(input.text, input.urls).links.length === 0
    ) {
      req.failed_payment_candidate = {
        ...previous.failedPayment,
        ens_chain_ids: [...previous.failedPayment.ens_chain_ids],
      };
    }
    req.prepend_messages.push(...prepend);
    const a: Active = { req, limits: this.deps.repos.db5.getAll() };
    s.active = a;
    this.deps.log.info({ event: 'request_received', session_id: s.session_id, request_id: req.request_id });
    // §14.4: the configured model must be available, otherwise every request fails with MODEL_FAILED.
    const modelOk = await modelReady(this.deps.llm);
    this.assertOpen(s);
    if (!modelOk) return this.finish(s, a, 's0', { kind: 'error', code: 'MODEL_FAILED' });
    return this.run(s, a, 0);
  }

  /** Runs steps from STEP_ORDER[start] up to S11 (S12 runs only after "yes"). */
  private async run(s: OpenSession, a: Active, start: number): Promise<AgentResponse> {
    const last = STEP_ORDER.indexOf('s11');
    for (let i = start; i <= last; i++) {
      const name = STEP_ORDER[i] as StepName;
      const res = await this.invoke(s, a, name, (ctx) => this.deps.registry[name].step(ctx));
      if (res.kind !== 'continue') return this.finish(s, a, name, res);
      if (name === 's11') return this.unsupported(s, a, 's11:continue');
      a.req.state = STATE_AFTER_STEP[name];
      this.deps.log.info({
        event: 'step_done',
        session_id: s.session_id,
        request_id: a.req.request_id,
        step: name,
        state: a.req.state,
      });
    }
    return this.unsupported(s, a, 'runner:end');
  }

  /** Answer to the pending question → the asking step's AnswerHandler (§13.4, step.ts runner semantics). */
  private async answer(s: OpenSession, a: Active, answer: Answer, input?: MessageInput): Promise<AgentResponse> {
    const paused = a.req.paused_at;
    if (paused === undefined) return this.unsupported(s, a, 'answer:not_paused');
    // Answers enter through both /answers and /messages. Screen them before DB8 or any step/model sees them.
    const text = answerText(answer);
    if (detectSecret(text) !== null || extractUrls(text, []).links.some((link) => urlHasSecret(link.url))) {
      return this.finish(s, a, paused.step, { kind: 'error', code: 'SECRET_DETECTED' });
    }
    // New content cannot be silently consumed as a field answer. Its full input goes through S1, before any
    // conversational model call could see it; attachments and extracted document values never enter the router.
    if (
      input &&
      (input.attachments.length ||
        input.pasted_blocks.length ||
        input.urls.length ||
        (this.deps.config.chat?.enabled && extractUrls(text, []).links.length > 0))
    ) {
      if (this.deps.repos.handoffs.get(a.req.request_id) !== undefined)
        return this.respond(s, a, 'awaiting_answer', [replyGuidance(this.context(s, a), paused.question)], {
          question: paused.question,
        });
      this.markDiscarded(a.req);
      return this.newRequest(s, input, [REPLY.PENDING_REPLACED()]);
    }
    if (
      answer.kind === 'text' &&
      this.deps.repos.handoffs.get(a.req.request_id) === undefined &&
      needsConversation(this.context(s, a), paused.question, text)
    )
      return this.conversationalAnswer(s, a, text, input);
    return this.applyFieldAnswer(s, a, answer, text);
  }

  private recordAnswer(s: OpenSession, a: Active, text: string, typed = true): void {
    const question = a.req.paused_at?.question;
    // §7.2: the session manager writes answers to DB8.
    this.deps.repos.db8.insertPrompt({
      session_id: s.session_id,
      request_id: a.req.request_id,
      kind: 'answer',
      text,
      created_at: this.nowIso(),
    });
    if (typed && question) {
      a.conversation ??= [];
      a.conversation.push({ question: question.code, reply: text });
      if (a.conversation.length > 6) a.conversation.shift();
    }
  }

  private async conversationalAnswer(
    s: OpenSession,
    a: Active,
    text: string,
    input?: MessageInput,
  ): Promise<AgentResponse> {
    const paused = a.req.paused_at;
    if (!paused) return this.unsupported(s, a, 'conversation:not_paused');
    const ctx = this.context(s, a);
    const clarify = (message = replyGuidance(ctx, paused.question)): AgentResponse =>
      this.respond(s, a, 'awaiting_answer', [message], { question: paused.question });
    let decision;
    try {
      decision = await interpretReply(ctx, paused.question, text, a.conversation ?? []);
    } catch (error) {
      if (!(error instanceof LlmFailed)) throw error;
      this.assertOpen(s);
      this.recordAnswer(s, a, text);
      return clarify(
        'I could not interpret that reply. Your request is still open; you can answer the displayed question or try again.',
      );
    }
    this.assertOpen(s);
    if (decision.intent === 'new_request') {
      // The model classifies intent only. It never writes a replacement prompt or transfers old consent.
      this.recordAnswer(s, a, text);
      this.markDiscarded(a.req);
      return this.newRequest(s, input ?? { text, pasted_blocks: [], attachments: [], urls: [] }, [
        REPLY.PENDING_REPLACED(),
      ]);
    }
    if (decision.intent === 'cancel') {
      this.recordAnswer(s, a, text);
      return explicitDraftCancellation(text) ? this.discard(s, a, REPLY.CANCELLED()) : clarify();
    }
    // "His address is …" remains an address answer even if the model calls it a recipient change.
    // Both interpretations use exactly the supplied address, through the existing address validator.
    if (
      decision.intent === 'recipient' &&
      decision.value !== null &&
      ['Q_WHO_IS', 'Q_ADDRESS_REENTER'].includes(paused.question.code) &&
      literalRecipientAddress(decision.value) &&
      answerOnlyReply(text, decision.value)
    )
      return this.applyFieldAnswer(s, a, { kind: 'text', text: decision.value }, text);
    if (decision.intent === 'recipient' && decision.value !== null && recipientOnlyReply(text, decision.value)) {
      if (paused.question.code === 'Q_NO_PAYEE')
        return this.applyFieldAnswer(s, a, { kind: 'text', text: decision.value }, text);
      this.recordAnswer(s, a, text);
      if (!canCorrectPendingRecipient(ctx))
        return clarify(
          'I need the full updated request to change the recipient here. Include the amount and schedule you want to keep.',
        );
      // Re-read current settings/balances. The normal S6 → S11 path resolves, validates and summarizes the change.
      a.limits = this.deps.repos.db5.getAll();
      const balances = await this.invoke(s, a, 's0', (current) => this.deps.registry.s0.step(current));
      if (balances.kind !== 'continue') return this.finish(s, a, 's0', balances);
      const result = await correctPendingRecipient(this.context(s, a), decision.value);
      this.assertOpen(s);
      if (result === null) return clarify();
      a.req.paused_at = undefined;
      if (result.kind !== 'continue') return this.finish(s, a, 's6', result);
      return this.run(s, a, STEP_ORDER.indexOf('s6'));
    }
    if (decision.intent === 'answer' && decision.value !== null && answerOnlyReply(text, decision.value)) {
      const q = paused.question;
      // Model interpretation cannot select consent, price/amount choices, contacts, or limit overrides.
      // A copied token may match an enabled native choice; consent and other discrete choices still need
      // the existing whole-reply match or an explicit chip.
      const freeValue =
        q.input === 'number' ||
        q.input === 'date' ||
        (q.code === 'Q_TOKEN' && matchChip(q, { kind: 'text', text: decision.value }) !== null) ||
        ['Q_NO_PAYEE', 'Q_WHO_IS', 'Q_ADDRESS_REENTER', 'Q_NAME_FOR_ADDRESS', 'Q_GROUP_PARENT'].includes(q.code);
      if (
        freeValue &&
        (!['Q_NO_PAYEE', 'Q_NAME_FOR_ADDRESS'].includes(q.code) || simpleRecipient(decision.value)) &&
        (!['Q_WHO_IS', 'Q_ADDRESS_REENTER'].includes(q.code) || literalRecipientAddress(decision.value))
      )
        return this.applyFieldAnswer(s, a, { kind: 'text', text: decision.value }, text);
    }
    this.recordAnswer(s, a, text);
    return clarify();
  }

  /** Validated routing ends here; the original field handler remains responsible for value validation. */
  private async applyFieldAnswer(
    s: OpenSession,
    a: Active,
    answer: Answer,
    originalText: string,
  ): Promise<AgentResponse> {
    const paused = a.req.paused_at;
    if (!paused) return this.unsupported(s, a, 'answer:not_paused');
    this.recordAnswer(s, a, originalText, answer.kind === 'text');
    const entry = this.deps.registry[paused.step];
    const handler = entry.onAnswer;
    if (handler === undefined) return this.unsupported(s, a, `${paused.step}:no_answer_handler`);
    a.req.paused_at = undefined;
    const res = await this.invoke(s, a, paused.step, (ctx) => handler(ctx, paused.question, answer));
    if (res.kind !== 'continue') return this.finish(s, a, paused.step, res);
    // `continue` from an AnswerHandler re-enters the same step.
    if (paused.step === 's12') return this.handoff(s, a);
    return this.run(s, a, STEP_ORDER.indexOf(paused.step));
  }

  /** S12 hand-off (§8.14): counts attempts; EXECUTION_UNAVAILABLE → HANDOFF_FAILED until 3 attempts in total. */
  private async handoff(s: OpenSession, a: Active): Promise<AgentResponse> {
    // G03: fresh limits and balances gate the first submission. Retries must preserve the submitted envelope.
    const firstSubmission = this.deps.repos.handoffs.get(a.req.request_id) === undefined;
    const oldSummary = JSON.stringify(a.req.summary);
    let limitsChanged = false;
    if (firstSubmission && a.req.plan !== undefined) {
      const current = this.deps.repos.db5.getAll();
      limitsChanged = JSON.stringify(current) !== JSON.stringify(a.limits);
      a.limits = current;
      if (limitsChanged) {
        a.req.limit_override = false;
        delete a.req.step_state.s10;
        delete a.req.envelope;
      }
      const refreshed = await this.invoke(s, a, 's0', (ctx) => this.deps.registry.s0.step(ctx));
      if (refreshed.kind !== 'continue') return this.finish(s, a, 's0', refreshed);
      a.req.notes = [...new Set(a.req.notes)];
    }
    // SQ-R-05: an autopay whose first occurrence has passed is never handed off; S9 asks Q_AUTOPAY_START and the
    // answer re-plans (S9 → S10 → S11) for a fresh confirmation.
    const recheck = this.deps.registry.s9.beforeHandoff;
    if (firstSubmission && recheck !== undefined) {
      const res = await this.invoke(s, a, 's9', async (ctx) => recheck(ctx) ?? { kind: 'continue' });
      if (res.kind !== 'continue') {
        if (res.kind === 'question') {
          // A new plan, a new envelope and a new confirmation follow.
          a.req.state = STATE_AFTER_STEP.s8;
          delete a.req.envelope;
          a.req.handoff_attempts = 0;
        }
        return this.finish(s, a, 's9', res);
      }
    }
    if (firstSubmission && a.req.plan !== undefined) {
      // Changed settings may alter chain selection, bridge padding, caps, or consent. Always show the new plan.
      if (limitsChanged) return this.run(s, a, STEP_ORDER.indexOf('s9'));
      const checked = await this.invoke(s, a, 's10', (ctx) => this.deps.registry.s10.step(ctx));
      if (checked.kind !== 'continue') return this.finish(s, a, 's10', checked);
      const prepend = [...a.req.prepend_messages];
      const summary = await this.invoke(s, a, 's11', (ctx) => this.deps.registry.s11.step(ctx));
      if (summary.kind !== 'summary') return this.finish(s, a, 's11', summary);
      if (JSON.stringify(summary.summary) !== oldSummary) return this.finish(s, a, 's11', summary);
      a.req.prepend_messages = prepend;
    }
    a.req.handoff_attempts += 1;
    const res = await this.invoke(s, a, 's12', (ctx) => this.deps.registry.s12.step(ctx));
    return this.finish(s, a, 's12', res);
  }

  /** Calls a step or handler; exceptions become MODEL_FAILED (LlmFailed) or INTERNAL_ERROR. */
  private async invoke(
    s: OpenSession,
    a: Active,
    step: StepName,
    fn: (ctx: StepContext) => Promise<StepResult>,
  ): Promise<StepResult> {
    let res: StepResult;
    try {
      res = await fn(this.context(s, a));
    } catch (e) {
      this.assertOpen(s);
      if (e instanceof LlmFailed) return { kind: 'error', code: 'MODEL_FAILED' };
      this.deps.log.error({
        event: 'step_exception',
        session_id: s.session_id,
        request_id: a.req.request_id,
        step,
        error_code: 'INTERNAL_ERROR',
      });
      return { kind: 'error', code: 'INTERNAL_ERROR' };
    }
    this.assertOpen(s);
    return res;
  }

  /** Applies a non-`continue` step result (or `continue` from S12) to the request and builds the response. */
  private finish(s: OpenSession, a: Active, step: StepName, res: StepResult): AgentResponse {
    const req = a.req;
    if (res.kind !== 'error') delete a.lastError;
    req.paused_at = undefined;
    switch (res.kind) {
      case 'question': {
        if (res.question.attempt > MAX_ATTEMPTS) return this.fail(s, a, 'TOO_MANY_RETRIES', undefined, 'FAILED');
        req.paused_at = { step, question: res.question };
        this.deps.log.info({
          event: 'question',
          session_id: s.session_id,
          request_id: req.request_id,
          step,
          question_code: res.question.code,
          attempt: res.question.attempt,
        });
        return this.respond(s, a, 'awaiting_answer', [], { question: res.question });
      }
      case 'answer': {
        req.state = step === 's12' ? 'HANDED_OFF' : 'ANSWERED';
        this.logFinal(req);
        return this.respond(s, a, 'done', res.messages);
      }
      case 'summary': {
        if (step !== 's11') return this.unsupported(s, a, `${step}:summary`);
        req.summary = res.summary;
        req.state = 'AWAITING_CONFIRMATION';
        return this.respond(s, a, 'awaiting_confirmation', [], { summary: res.summary });
      }
      case 'error': {
        if (step === 's12' && res.code === 'EXECUTION_UNAVAILABLE') {
          a.lastHandoffCause = res.params?.cause ?? 'server_error';
          const state = req.handoff_attempts < MAX_HANDOFF_ATTEMPTS ? 'HANDOFF_FAILED' : 'FAILED';
          // SQ-A-06, F-9: the 3rd failure's cause (S12 `params.cause`) picks the final text.
          const params = state === 'FAILED' ? { final: res.params?.cause ?? 'server_error' } : undefined;
          this.deps.log.warn({
            event: 'handoff_failed',
            session_id: s.session_id,
            request_id: req.request_id,
            attempt: req.handoff_attempts,
            error_code: res.code,
          });
          return this.fail(s, a, res.code, params, state);
        }
        return this.fail(s, a, res.code, res.params, res.final_state ?? 'FAILED');
      }
      case 'discard':
        return this.discard(s, a, ...(res.messages ?? [REPLY.CANCELLED()]));
      case 'continue': {
        if (step !== 's12') return this.unsupported(s, a, `${step}:continue`);
        req.state = 'HANDED_OFF';
        this.logFinal(req);
        return this.respond(s, a, 'done', [REPLY.HANDED_OFF()]);
      }
      default:
        return this.unsupported(s, a, `${step}:unknown_result`);
    }
  }

  private fail(
    s: OpenSession,
    a: Active,
    code: ErrorCode,
    params: Record<string, string> | undefined,
    state: 'FAILED' | 'ANSWERED' | 'HANDOFF_FAILED',
  ): AgentResponse {
    let errCode = code;
    let message: string;
    try {
      message = ERROR_MESSAGE[code](params ?? {});
    } catch {
      // A step returned an error without the catalog parameters it needs: a bug (§11.1 INTERNAL_ERROR).
      this.deps.log.error({
        event: 'error_params_missing',
        session_id: s.session_id,
        request_id: a.req.request_id,
        error_code: code,
      });
      errCode = 'INTERNAL_ERROR';
      message = ERROR_MESSAGE.INTERNAL_ERROR({});
      state = 'FAILED';
    }
    a.req.state = state;
    a.req.paused_at = undefined;
    a.lastError = { code: errCode, message };
    a.failedPayment =
      state === 'FAILED' && errCode === 'INSUFFICIENT_FUNDS' ? failedPaymentContext(a.req, this.deps.repos) : undefined;
    if (state !== 'HANDOFF_FAILED') this.logFinal(a.req, errCode);
    return this.respond(s, a, 'error', [], { error: a.lastError });
  }

  /** Request DISCARDED with a reply (§17.3, §13.3). Never written to db8_history (only S12 appends). */
  private discard(s: OpenSession, a: Active, ...messages: string[]): AgentResponse {
    delete a.lastError;
    this.markDiscarded(a.req);
    return this.respond(s, a, 'done', messages);
  }

  private markDiscarded(req: AgentRequest): void {
    req.state = 'DISCARDED';
    req.paused_at = undefined;
    this.logFinal(req);
  }

  /** §0: a state this spec does not cover → UNSUPPORTED_REQUEST; log the internal state code (SQ-19). */
  private unsupported(s: OpenSession, a: Active, rule_id: string): AgentResponse {
    this.logUnsupported(s, a.req.state, rule_id, a.req.request_id);
    return this.fail(s, a, 'UNSUPPORTED_REQUEST', undefined, 'FAILED');
  }

  private respond(
    s: OpenSession,
    a: Active,
    state: ResponseState,
    messages: string[],
    extra: Pick<AgentResponse, 'question' | 'summary' | 'error'> = {},
  ): AgentResponse {
    const all = [...a.req.prepend_messages, ...messages];
    a.req.prepend_messages = [];
    const body: AgentResponse = {
      session_id: s.session_id,
      request_id: a.req.request_id,
      state,
      messages: all.map((text) => ({ type: 'text' as const, text })),
    };
    if (extra.question !== undefined) body.question = extra.question;
    if (extra.summary !== undefined) body.summary = extra.summary;
    if (extra.error !== undefined) body.error = extra.error;
    return body;
  }

  /** §18 metrics: one line per final state (with the error code when there is one). */
  private logFinal(req: AgentRequest, error_code?: ErrorCode): void {
    this.deps.log.info({
      event: 'request_final',
      session_id: req.session_id,
      request_id: req.request_id,
      state: req.state,
      ...(error_code !== undefined ? { error_code } : {}),
    });
  }

  private context(s: OpenSession, a: Active): StepContext {
    const d = this.deps;
    return {
      req: a.req,
      repos: d.repos,
      llm: d.llm,
      rpc: d.rpc,
      ens: d.ens,
      subnames: d.subnames,
      exec: d.exec,
      fetcher: d.fetcher,
      config: d.config,
      limits: a.limits,
      now: () => this.clock().setZone(s.timezone),
      timezone: s.timezone,
      log: d.log,
    };
  }

  private assertOpen(s: OpenSession): void {
    if (s.closed || this.open !== s) throw new SessionClosed();
  }

  private nowIso(): string {
    return toIsoUtc(this.clock());
  }
}

/** Text stored in db8_prompts for an answer (kind 'answer'). */
function answerText(answer: Answer): string {
  switch (answer.kind) {
    case 'chip':
      return answer.chip_id;
    case 'text':
      return answer.text;
    case 'selected':
      return JSON.stringify(answer.selected_ids);
  }
}
