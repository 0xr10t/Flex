// Lane A test harness for the Fastify app: createApp over fake (or real) repos with a stub step registry, dummy
// tokens, and an `inject` helper. No socket is ever opened.
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import type { Repos } from '../../../src/contracts/repos.js';
import {
  STEP_ORDER,
  type AnswerHandler,
  type Step,
  type StepEntry,
  type StepName,
} from '../../../src/contracts/step.js';
import type { AgentResponse } from '../../../src/contracts/types.js';
import { createApp } from '../../../src/server/app.js';
import type { StepRegistry } from '../../../src/session/manager.js';
import { testConfig } from '../../fakes/context.js';
import { CapturingLogger, FakeEns, FakeExecution, FakeFetcher, FakeRpc, FakeSubnames } from '../../fakes/io.js';
import { FixtureLlmClient } from '../../fakes/llm.js';
import { createFakeRepos, type FakeRepos } from '../../fakes/repos.js';
import { SUMMARY } from './session-harness.js';

export const UI_TOKEN = 'ui-token-dummy-0000000000000000000000000000000000000000000000000000';
export const REPORT_TOKEN = 'report-token-dummy-00000000000000000000000000000000000000000000000';

export interface ServerHarness<R extends Repos = FakeRepos> {
  app: FastifyInstance;
  repos: R;
  llm: FixtureLlmClient;
  log: CapturingLogger;
  set(step: StepName, entry: Partial<StepEntry>): void;
  /** Request with the UI token by default; `token: null` sends no Authorization header. */
  call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    opts?: { token?: string | null; scheme?: string; body?: unknown; raw?: string },
  ): Promise<{ status: number; json: Record<string, unknown>; text: string }>;
  openSession(timezone?: string): Promise<string>;
  message(sid: string, text?: string): Promise<{ status: number; body: AgentResponse }>;
}

export function makeServer<R extends Repos = FakeRepos>(opts: { repos?: R } = {}): ServerHarness<R> {
  const repos = (opts.repos ?? createFakeRepos()) as R;
  const llm = new FixtureLlmClient({ calls: [] });
  const log = new CapturingLogger();
  const steps: Partial<Record<StepName, Step>> = {};
  const handlers: Partial<Record<StepName, AnswerHandler | undefined>> = {};
  const entries = {} as Record<StepName, StepEntry>;
  for (const name of STEP_ORDER) {
    steps[name] = async () => (name === 's11' ? { kind: 'summary', summary: SUMMARY } : { kind: 'continue' as const });
    handlers[name] = async () => ({ kind: 'continue' });
    entries[name] = {
      step: (ctx) => (steps[name] as Step)(ctx),
      onAnswer: (ctx, q, a) => (handlers[name] as AnswerHandler)(ctx, q, a),
    };
  }
  const registry: StepRegistry = entries;
  const app = createApp({
    repos,
    llm,
    rpc: new FakeRpc(),
    ens: new FakeEns(),
    subnames: new FakeSubnames(),
    exec: new FakeExecution(),
    fetcher: new FakeFetcher(),
    log,
    config: testConfig(),
    registry,
    tokens: { ui: UI_TOKEN, report: REPORT_TOKEN },
    clock: () => DateTime.fromISO('2026-11-05T17:30:00.000Z', { zone: 'utc' }),
  });
  const call: ServerHarness<R>['call'] = async (method, url, o = {}) => {
    const headers: Record<string, string> = {};
    if (o.token !== null) headers.authorization = `${o.scheme ?? 'Bearer'} ${o.token ?? UI_TOKEN}`;
    const payload = o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined);
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const res = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.statusCode, json, text: res.body };
  };
  return {
    app,
    repos,
    llm,
    log,
    call,
    set(step, entry) {
      if (entry.step !== undefined) steps[step] = entry.step;
      if ('onAnswer' in entry) handlers[step] = entry.onAnswer;
    },
    async openSession(timezone = 'Asia/Kolkata') {
      const r = await call('POST', '/v1/sessions', { body: { timezone } });
      return r.json.session_id as string;
    },
    async message(sid, text = 'send 50 usdc to aradhya') {
      const r = await call('POST', `/v1/sessions/${sid}/messages`, { body: { text } });
      return { status: r.status, body: r.json as unknown as AgentResponse };
    },
  };
}
