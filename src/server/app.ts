// Implements: §14.1 UI → agent HTTP API (every route, bearer UI token on every request, JSON bodies with base64
// attachments, max body 20 MB, AgentResponse with HTTP 200 unless the HTTP request itself is invalid, 404/409
// rules, one call per session at a time → 409, settings API, health), §14.3 reports endpoint with the
// execution-report token, §16.4 UI and report tokens are different and checked per route, §7.2 / §16.3 the only
// DB5 write path is PUT /v1/settings/limits, §14.4 /v1/health `ollama`. Binding to 127.0.0.1 happens in main()
// (src/index.ts) from the validated config. Owner: Lane A.

import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { DateTime, IANAZone } from 'luxon';
import type {
  AllowlistLogger,
  ContentFetcher,
  EnsClient,
  ExecutionClient,
  RpcClients,
  SubnameSource,
} from '../contracts/io.js';
import type { LlmClient } from '../contracts/llm.js';
import type { Repos } from '../contracts/repos.js';
import type { NewId } from '../contracts/step.js';
import type { Config, ExecutionReport, MessageInput } from '../contracts/types.js';
import { SessionManager, type AnswerBody, type SessionResult, type StepRegistry } from '../session/manager.js';
import {
  validateAnswer,
  validateCancel,
  validateConfirm,
  validateMessage,
  validateOpenSession,
  validateReport,
} from './bodies.js';
import { applyReport } from './reports.js';
import { validateLimits } from './settings.js';

/** §14.1 "Max body 20 MB". */
export const MAX_BODY_BYTES = 20 * 1024 * 1024;
export const REPORTS_PATH = '/v1/execution/reports';

const HTTP_ERROR_NAME: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  404: 'Not Found',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  500: 'Internal Server Error',
};

export interface AppDeps {
  repos: Repos;
  llm: LlmClient;
  rpc: RpcClients;
  ens: EnsClient;
  subnames: SubnameSource;
  exec: ExecutionClient;
  fetcher: ContentFetcher;
  log: AllowlistLogger;
  config: Config;
  /** Step registry (src/pipeline/registry.ts once wired; stub steps in tests). */
  registry: StepRegistry;
  /** Bearer tokens (§14.1 UI, §14.3 execution report). Must differ (§16.4). */
  tokens: { ui: string; report: string };
  clock?: () => DateTime;
  newId?: NewId;
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

function sendResult(reply: FastifyReply, r: SessionResult): FastifyReply {
  if (r.kind === 'not_found') return reply.code(404).send({ statusCode: 404, error: 'Not Found' });
  if (r.kind === 'conflict') return reply.code(409).send({ statusCode: 409, error: 'Conflict' });
  return reply.code(200).send(r.body);
}

const badRequest = (reply: FastifyReply): FastifyReply =>
  reply.code(400).send({ statusCode: 400, error: 'Bad Request' });

export function createApp(deps: AppDeps): FastifyInstance {
  if (deps.tokens.ui === deps.tokens.report) throw new Error('UI and execution-report tokens must differ (§16.4)');
  const clock = deps.clock ?? (() => DateTime.utc());
  const nowIso = (): string => clock().toUTC().toISO() ?? new Date().toISOString();
  const manager = new SessionManager({
    repos: deps.repos,
    llm: deps.llm,
    rpc: deps.rpc,
    ens: deps.ens,
    subnames: deps.subnames,
    exec: deps.exec,
    fetcher: deps.fetcher,
    log: deps.log,
    config: deps.config,
    registry: deps.registry,
    clock,
    ...(deps.newId !== undefined ? { newId: deps.newId } : {}),
  });

  // No Fastify request logging: URLs and bodies must never reach a log (§18).
  const app = Fastify({ logger: false, bodyLimit: MAX_BODY_BYTES });

  // §14.1 / §14.3 / §16.4: every route needs a bearer token; the reports route takes only the report token, every
  // other route only the UI token.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const isReports = request.routeOptions.url === REPORTS_PATH;
    const expected = isReports ? deps.tokens.report : deps.tokens.ui;
    if (!tokenMatches(request.headers.authorization, expected)) {
      return reply.code(401).send({ statusCode: 401, error: 'Unauthorized' });
    }
    return undefined;
  });

  // Fastify errors (malformed JSON → 400, body over 20 MB → 413, …): status only, never the error text (§18).
  app.setErrorHandler((error: { statusCode?: number }, _request, reply) => {
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) deps.log.error({ event: 'http_error', http_status: status });
    return reply.code(status).send({ statusCode: status, error: HTTP_ERROR_NAME[status] ?? 'Error' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ statusCode: 404, error: 'Not Found' }));

  // ── sessions (§14.1, §17.1) ──
  app.post('/v1/sessions', async (request, reply) => {
    const body = request.body;
    if (!validateOpenSession(body)) return badRequest(reply);
    const { timezone } = body as { timezone: string };
    if (!IANAZone.isValidZone(timezone)) return badRequest(reply);
    return reply.code(200).send(manager.openSession(timezone));
  });

  app.delete<{ Params: { id: string } }>('/v1/sessions/:id', async (request, reply) => {
    if (!manager.closeSession(request.params.id)) return reply.code(404).send({ statusCode: 404, error: 'Not Found' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/v1/sessions/:id/messages', async (request, reply) => {
    const body = request.body;
    if (!validateMessage(body)) return badRequest(reply);
    const b = body as Partial<MessageInput> & { text: string };
    const input: MessageInput = {
      text: b.text,
      pasted_blocks: b.pasted_blocks ?? [],
      attachments: b.attachments ?? [],
      urls: b.urls ?? [],
    };
    return sendResult(reply, await manager.handleMessage(request.params.id, input));
  });

  app.post<{ Params: { id: string } }>('/v1/sessions/:id/answers', async (request, reply) => {
    const body = request.body;
    if (!validateAnswer(body)) return badRequest(reply);
    return sendResult(reply, await manager.handleAnswer(request.params.id, body as AnswerBody));
  });

  app.post<{ Params: { id: string } }>('/v1/sessions/:id/confirm', async (request, reply) => {
    const body = request.body;
    if (!validateConfirm(body)) return badRequest(reply);
    const { request_id, decision } = body as { request_id: string; decision: 'yes' | 'no' };
    return sendResult(reply, await manager.handleConfirm(request.params.id, request_id, decision));
  });

  app.post<{ Params: { id: string } }>('/v1/sessions/:id/cancel', async (request, reply) => {
    const body = request.body;
    if (!validateCancel(body)) return badRequest(reply);
    const { request_id } = body as { request_id: string };
    return sendResult(reply, await manager.handleCancel(request.params.id, request_id));
  });

  // ── settings (§14.1, §7.2: the only DB5 write path) ──
  app.get('/v1/settings/limits', async (_request, reply) => reply.code(200).send(deps.repos.db5.getAll()));

  app.put('/v1/settings/limits', async (request, reply) => {
    const v = validateLimits(request.body, deps.config);
    if (!v.ok) return reply.code(400).send({ statusCode: 400, error: 'Bad Request', errors: v.errors });
    deps.repos.db5.putAll(v.limits, nowIso());
    deps.log.info({ event: 'limits_updated' });
    return reply.code(200).send(deps.repos.db5.getAll());
  });

  // ── health (§14.1, §14.4) ──
  app.get('/v1/health', async (_request, reply) => {
    let ollama = false;
    try {
      ollama = await deps.llm.modelAvailable();
    } catch {
      ollama = false;
    }
    let db = true;
    try {
      deps.repos.db5.getAll();
    } catch {
      db = false;
    }
    return reply.code(200).send({ ok: true, ollama, db });
  });

  // ── execution reports (§14.3) ──
  app.post(REPORTS_PATH, async (request, reply) => {
    const body = request.body;
    if (!validateReport(body)) return badRequest(reply);
    const outcome = applyReport(deps.repos, body as ExecutionReport, nowIso());
    deps.log.info({ event: 'execution_report', http_status: outcome });
    if (outcome === 204) return reply.code(204).send();
    if (outcome === 404) return reply.code(404).send({ statusCode: 404, error: 'Not Found' });
    return badRequest(reply);
  });

  return app;
}
