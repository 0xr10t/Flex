// Implements: §17.1 session lifecycle (one open session, opening closes the previous one, close clears DB1/DB3/DB8
// via §7.4 and abandons an in-progress request as DISCARDED, no idle timeout), §8.0 one active request per session
// kept in memory, §3.3 fixed step order run through the injected registry (runner semantics of
// src/contracts/step.ts: S0–S2 only for new messages, pause/resume on questions, `continue` from an AnswerHandler
// re-enters the same step), §9.7 / §13.4 max_attempts 4 → TOO_MANY_RETRIES, §17.3 confirmation/answer/cancel
// table, §8.14 step 6 / I-37 HANDOFF_FAILED retried up to 3 attempts in total, §13.3 fixed replies, §14.1
// AgentResponse, §14.4 MODEL_FAILED when the model is unavailable, §15 error responses, §0 / SQ-19 uncovered states
// → UNSUPPORTED_REQUEST with an `unsupported_state` log line (SQ-A-01 cancel without a matching request, SQ-A-03
// message while HANDOFF_FAILED), §18 metrics as log events.
// Owner: Lane A.

import { DateTime, IANAZone } from 'luxon';
import { ERROR_MESSAGE, REPLY } from '../contracts/catalog.js';
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
  AgentResponse,
  Answer,
  Config,
  ErrorCode,
  Limits,
  MessageInput,
  RequestId,
  ResponseState,
  SessionId,
} from '../contracts/types.js';
import { newId as defaultNewId } from '../util/ids.js';
import { isAwaitingAnswer, isTerminal, newAgentRequest, STATE_AFTER_STEP } from './request.js';
import { classifyConfirmationText, isCancelText } from './texts.js';

/** §13.4 `max_attempts`. */
export const MAX_ATTEMPTS = 4;
/** §8.14 step 6: hand-off attempts in total. */
export const MAX_HANDOFF_ATTEMPTS = 3;
/** §7.3 rule 3 applied to session ids (db8_sessions primary key). */
const MAX_ID_DRAWS = 5;

export type StepRegistry = Readonly<Record<StepName, StepEntry>>;

export interface SessionManagerDeps {
  repos: Repos;
  llm: LlmClient;
  rpc: RpcClients;
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
}

interface OpenSession {
  session_id: SessionId;
  timezone: string;
  active: Active | null;
  /** §14.1: one call per session at a time. */
  busy: boolean;
  closed: boolean;
}

/** Thrown out of a run when the session was closed while a step was awaiting (§17.1: request abandoned). */
class SessionClosed extends Error {}

const ok = <T>(body: T): SessionResult<T> => ({ kind: 'ok', body });
const NOT_FOUND = { kind: 'not_found' } as const;
const CONFLICT = { kind: 'conflict' } as const;

export class SessionManager {
  private readonly deps: SessionManagerDeps;
  private readonly clock: () => DateTime;
  private readonly newId: NewId;
  private open: OpenSession | null = null;

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => DateTime.utc());
    this.newId = deps.newId ?? defaultNewId;
  }

  // ───────────────────────────── sessions (§17.1) ─────────────────────────────

  /** POST /v1/sessions: closes any open session (clearing DB1/DB3/DB8), opens a new one. */
  openSession(timezone: string): { session_id: SessionId } {
    if (!IANAZone.isValidZone(timezone)) throw new Error('invalid timezone');
    if (this.open !== null) this.closeOpen(this.open);
    const opened_at = this.nowIso();
    for (let i = 0; i < MAX_ID_DRAWS; i++) {
      const session_id = this.newId('session') as SessionId;
      if (this.deps.repos.db8.getSession(session_id) !== undefined) continue;
      this.deps.repos.db8.insertSession({ session_id, timezone, opened_at });
      this.open = { session_id, timezone, active: null, busy: false, closed: false };
      this.deps.log.info({ event: 'session_opened', session_id });
      return { session_id };
    }
    throw new Error('session id collision');
  }

  /**
   * DELETE /v1/sessions/{id}: closes the session and clears DB1, DB3, DB8 (§7.4). Returns false for an unknown id.
   * A session left in DB8 by a crashed process is known and can be closed too (ADR-007).
   */
  closeSession(session_id: string): boolean {
    if (this.open !== null && this.open.session_id === session_id) {
      this.closeOpen(this.open);
      return true;
    }
    if (this.deps.repos.db8.getSession(session_id) !== undefined) {
      this.deps.repos.clearSessionStores();
      this.deps.log.info({ event: 'session_closed', session_id });
      return true;
    }
    return false;
  }

  /** The open session id, if any (one at a time, I-08). */
  openSessionId(): SessionId | null {
    return this.open?.session_id ?? null;
  }

  private closeOpen(s: OpenSession): void {
    s.closed = true;
    this.open = null;
    const a = s.active;
    if (a !== null && !isTerminal(a.req)) {
      a.req.state = 'DISCARDED';
      a.req.paused_at = undefined;
      this.logFinal(a.req);
    }
    s.active = null;
    this.deps.repos.clearSessionStores();
    this.deps.log.info({ event: 'session_closed', session_id: s.session_id });
  }

  // ───────────────────────────── calls (§14.1, §17.3) ─────────────────────────────

  /** POST /v1/sessions/{id}/messages: a new request, or an answer/confirmation per §17.3. */
  async handleMessage(session_id: string, input: MessageInput): Promise<SessionResult> {
    return this.exclusive(session_id, async (s) => {
      const a = s.active;
      if (a !== null && isAwaitingAnswer(a.req)) {
        // §17.3: cancel texts drop the request; any other text is a free-text answer to the pending question.
        if (isCancelText(input.text)) return ok(this.discard(s, a, REPLY.CANCELLED()));
        return ok(await this.answer(s, a, { kind: 'text', text: input.text }));
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
            a.req.state = 'DISCARDED';
            this.logFinal(a.req);
            return ok(await this.newRequest(s, input, [REPLY.PENDING_REPLACED()]));
          }
        }
      }
      if (a !== null && a.req.state === 'HANDOFF_FAILED') {
        // §17.3 has no row for a messages call while HANDOFF_FAILED (spec-questions/A.md SQ-A-03). Interim: cancel
        // texts cancel it like the cancel endpoint; any other text → UNSUPPORTED_REQUEST (§0) and the request stays
        // HANDOFF_FAILED, so `confirm` yes can still retry it.
        if (isCancelText(input.text)) return ok(this.discard(s, a, REPLY.CANCELLED()));
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
   * retry) → DISCARDED, reply CANCELLED. No such request with this id: not covered by §14.1/§17.3 →
   * UNSUPPORTED_REQUEST (§0; spec-questions/A.md SQ-A-01).
   */
  async handleCancel(session_id: string, request_id: string): Promise<SessionResult> {
    return this.exclusive(session_id, async (s) => {
      const a = s.active;
      const cancellable =
        a !== null &&
        a.req.request_id === request_id &&
        (isAwaitingAnswer(a.req) || a.req.state === 'AWAITING_CONFIRMATION' || a.req.state === 'HANDOFF_FAILED');
      if (cancellable) return ok(this.discard(s, a, REPLY.CANCELLED()));
      this.logUnsupported(s, a?.req.state ?? 'NONE', 'cancel:no_active_request');
      return ok(this.unsupportedReply(s, request_id));
    });
  }

  /** §0 / SQ-19: an uncovered input is logged with its state and branch id (no request is changed). */
  private logUnsupported(s: OpenSession, state: string, rule_id: string, request_id?: string): void {
    this.deps.log.warn({
      event: 'unsupported_state',
      session_id: s.session_id,
      ...(request_id !== undefined ? { request_id } : {}),
      state,
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

  /** §14.1: one call per session at a time (second concurrent call → 409); unknown/closed session → 404. */
  private async exclusive(session_id: string, fn: (s: OpenSession) => Promise<SessionResult>): Promise<SessionResult> {
    const s = this.open;
    if (s === null || s.session_id !== session_id) return NOT_FOUND;
    if (s.busy) return CONFLICT;
    s.busy = true;
    try {
      return await fn(s);
    } catch (e) {
      if (e instanceof SessionClosed) return NOT_FOUND;
      throw e;
    } finally {
      s.busy = false;
    }
  }

  private async newRequest(s: OpenSession, input: MessageInput, prepend: string[]): Promise<AgentResponse> {
    const prev = s.active;
    if (prev !== null && !isTerminal(prev.req)) {
      // Unreachable through handleMessage (awaiting states are handled first); kept so §8.0 "one active request"
      // holds for any caller.
      prev.req.state = 'DISCARDED';
      this.logFinal(prev.req);
    }
    const req = newAgentRequest(this.newId('request') as RequestId, s.session_id, input);
    req.prepend_messages.push(...prepend);
    const a: Active = { req, limits: this.deps.repos.db5.getAll() };
    s.active = a;
    this.deps.log.info({ event: 'request_received', session_id: s.session_id, request_id: req.request_id });
    // §14.4: the configured model must be available, otherwise every request fails with MODEL_FAILED.
    let modelOk: boolean;
    try {
      modelOk = await this.deps.llm.modelAvailable();
    } catch {
      modelOk = false;
    }
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
  private async answer(s: OpenSession, a: Active, answer: Answer): Promise<AgentResponse> {
    const paused = a.req.paused_at;
    if (paused === undefined) return this.unsupported(s, a, 'answer:not_paused');
    // §7.2: the session manager writes answers to DB8.
    this.deps.repos.db8.insertPrompt({
      session_id: s.session_id,
      request_id: a.req.request_id,
      kind: 'answer',
      text: answerText(answer),
      created_at: this.nowIso(),
    });
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
          const state = req.handoff_attempts < MAX_HANDOFF_ATTEMPTS ? 'HANDOFF_FAILED' : 'FAILED';
          this.deps.log.warn({
            event: 'handoff_failed',
            session_id: s.session_id,
            request_id: req.request_id,
            attempt: req.handoff_attempts,
            error_code: res.code,
          });
          return this.fail(s, a, res.code, res.params, state);
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
    if (state !== 'HANDOFF_FAILED') this.logFinal(a.req, errCode);
    return this.respond(s, a, 'error', [], { error: { code: errCode, message } });
  }

  /** Request DISCARDED with a reply (§17.3, §13.3). Never written to db8_history (only S12 appends). */
  private discard(s: OpenSession, a: Active, ...messages: string[]): AgentResponse {
    a.req.state = 'DISCARDED';
    a.req.paused_at = undefined;
    this.logFinal(a.req);
    return this.respond(s, a, 'done', messages);
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
    return this.clock().toUTC().toISO() ?? new Date().toISOString();
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
