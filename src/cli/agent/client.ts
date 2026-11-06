// The CLI's client for the agent's local HTTP API (§14.1): sessions, messages, answers, confirmations, cancels, the
// limits settings and health. Every call carries the UI bearer token. The CLI is the "wallet UI" of the spec.

import type { AgentResponse } from '../../contracts/types.js';

export type { AgentResponse };

/** The limits settings (DB5, §6.3) as the API returns them. */
export type Limits = Record<string, unknown>;

export interface Health {
  ok: boolean;
  ollama: boolean;
  db: boolean;
}

/** An answer to the pending question, in one of the three shapes /answers accepts. */
export type AnswerBody =
  | { question_id: string; chip_id: string }
  | { question_id: string; text: string }
  | { question_id: string; selected_ids: string[] };

export interface AgentApi {
  health(): Promise<Health>;
  openSession(timezone: string): Promise<string>;
  closeSession(sessionId: string): Promise<void>;
  message(sessionId: string, text: string): Promise<AgentResponse>;
  answer(sessionId: string, body: AnswerBody): Promise<AgentResponse>;
  confirm(sessionId: string, requestId: string, decision: 'yes' | 'no'): Promise<AgentResponse>;
  cancel(sessionId: string, requestId: string): Promise<AgentResponse>;
  getLimits(): Promise<Limits>;
  putLimits(limits: Limits): Promise<Limits>;
}

/** A non-2xx reply. `fields` carries the per-field errors a 400 from PUT /v1/settings/limits lists. */
export class AgentHttpError extends Error {
  constructor(
    readonly status: number,
    readonly fields: string[] = [],
  ) {
    super(`agent replied ${status}`);
  }
}

/** The agent could not be reached at all (not running, or the call timed out). */
export class AgentUnreachableError extends Error {}

/** Quick calls (sessions, settings, health) and pipeline calls, which can run several local-model steps. */
const SHORT_TIMEOUT_MS = 15_000;
const PIPELINE_TIMEOUT_MS = 5 * 60_000;

export class AgentClient implements AgentApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = SHORT_TIMEOUT_MS): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AgentUnreachableError('agent unreachable');
    }
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => undefined)) as unknown;
    if (!res.ok) {
      const errors = (json as { errors?: unknown } | undefined)?.errors;
      throw new AgentHttpError(res.status, Array.isArray(errors) ? errors.map(String) : []);
    }
    return json as T;
  }

  health(): Promise<Health> {
    return this.call('GET', '/v1/health');
  }

  async openSession(timezone: string): Promise<string> {
    return (await this.call<{ session_id: string }>('POST', '/v1/sessions', { timezone })).session_id;
  }

  closeSession(sessionId: string): Promise<void> {
    return this.call('DELETE', `/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  message(sessionId: string, text: string): Promise<AgentResponse> {
    return this.call('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/messages`, { text }, PIPELINE_TIMEOUT_MS);
  }

  answer(sessionId: string, body: AnswerBody): Promise<AgentResponse> {
    return this.call('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/answers`, body, PIPELINE_TIMEOUT_MS);
  }

  confirm(sessionId: string, requestId: string, decision: 'yes' | 'no'): Promise<AgentResponse> {
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/confirm`;
    return this.call('POST', path, { request_id: requestId, decision }, PIPELINE_TIMEOUT_MS);
  }

  cancel(sessionId: string, requestId: string): Promise<AgentResponse> {
    return this.call('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, { request_id: requestId });
  }

  getLimits(): Promise<Limits> {
    return this.call('GET', '/v1/settings/limits');
  }

  putLimits(limits: Limits): Promise<Limits> {
    return this.call('PUT', '/v1/settings/limits', limits);
  }
}
