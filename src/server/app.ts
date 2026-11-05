// Implements: §14.1 UI → agent HTTP API (every route, bearer UI token on every request, JSON bodies with base64
// attachments, max body 20 MB, AgentResponse with HTTP 200 unless the HTTP request itself is invalid, 404/409
// rules, one call per session at a time → 409, settings API, health), §14.3 reports endpoint with the
// execution-report token, §16.4 UI and report tokens are different and checked per route, §7.2 / §16.3 the only
// DB5 write path is PUT /v1/settings/limits, §14.4 /v1/health `ollama`. Binding to 127.0.0.1 happens in main()
// (src/index.ts) from the validated config. Owner: Lane A.

import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { DateTime, IANAZone } from 'luxon';
import type { MessageInput } from '../contracts/types.js';
import {
  modelReady,
  SessionManager,
  toIsoUtc,
  type SessionManagerDeps,
  type SessionResult,
} from '../session/manager.js';
import {
  isBase64,
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
  401: 'Unauthorized',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  500: 'Internal Server Error',
};

export interface AppDeps extends SessionManagerDeps {
  /** Bearer tokens (§14.1 UI, §14.3 execution report). Must differ (§16.4). */
  tokens: { ui: string; report: string };
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

/** An error reply: status and its name only, never error text or request content (§18). */
const httpError = (reply: FastifyReply, status: number): FastifyReply =>
  reply.code(status).send({ statusCode: status, error: HTTP_ERROR_NAME[status] ?? 'Error' });

const badRequest = (reply: FastifyReply): FastifyReply => httpError(reply, 400);

function sendResult(reply: FastifyReply, r: SessionResult): FastifyReply {
  if (r.kind === 'not_found') return httpError(reply, 404);
  if (r.kind === 'conflict') return httpError(reply, 409);
  return reply.code(200).send(r.body);
}

export function createApp(deps: AppDeps): FastifyInstance {
  const { tokens, ...managerDeps } = deps;
  if (tokens.ui === tokens.report) throw new Error('UI and execution-report tokens must differ (§16.4)');
  const clock = deps.clock ?? (() => DateTime.utc());
  const nowIso = (): string => toIsoUtc(clock());
  const manager = new SessionManager({ ...managerDeps, clock });

  // No Fastify request logging: URLs and bodies must never reach a log (§18).
  const app = Fastify({ logger: false, bodyLimit: MAX_BODY_BYTES });

  // §14.1 / §14.3 / §16.4: every route needs a bearer token; the reports route takes only the report token, every
  // other route only the UI token.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const isReports = request.routeOptions.url === REPORTS_PATH;
    const expected = isReports ? tokens.report : tokens.ui;
    if (!tokenMatches(request.headers.authorization, expected)) return httpError(reply, 401);
    return undefined;
  });

  // Fastify errors (malformed JSON → 400, body over 20 MB → 413, …): status only, never the error text (§18).
  app.setErrorHandler((error: { statusCode?: number }, _request, reply) => {
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) deps.log.error({ event: 'http_error', http_status: status });
    return httpError(reply, status);
  });
  app.setNotFoundHandler((_request, reply) => httpError(reply, 404));

  // ── sessions (§14.1, §17.1) ──
  app.post('/v1/sessions', async (request, reply) => {
    const body = request.body;
    if (!validateOpenSession(body) || !IANAZone.isValidZone(body.timezone)) return badRequest(reply);
    return reply.code(200).send(manager.openSession(body.timezone));
  });

  // §14.1: this route has no body, so a JSON content type with an empty body must not reach the JSON parser (→ 400).
  const ignoreBody = async (request: FastifyRequest): Promise<void> => {
    delete request.headers['content-type'];
  };
  app.delete<{ Params: { id: string } }>('/v1/sessions/:id', { onRequest: ignoreBody }, async (request, reply) => {
    if (!manager.closeSession(request.params.id)) return httpError(reply, 404);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/v1/sessions/:id/messages', async (request, reply) => {
    const body = request.body;
    if (!validateMessage(body)) return badRequest(reply);
    if (!(body.attachments ?? []).every((a) => isBase64(a.base64))) return badRequest(reply);
    const input: MessageInput = {
      text: body.text,
      pasted_blocks: body.pasted_blocks ?? [],
      attachments: body.attachments ?? [],
      urls: body.urls ?? [],
    };
    return sendResult(reply, await manager.handleMessage(request.params.id, input));
  });

  app.post<{ Params: { id: string } }>('/v1/sessions/:id/answers', async (request, reply) => {
    const body = request.body;
    if (!validateAnswer(body)) return badRequest(reply);
    return sendResult(reply, await manager.handleAnswer(request.params.id, body));
  });

  app.post<{ Params: { id: string } }>('/v1/sessions/:id/confirm', async (request, reply) => {
    const body = request.body;
    if (!validateConfirm(body)) return badRequest(reply);
    return sendResult(reply, await manager.handleConfirm(request.params.id, body.request_id, body.decision));
  });

  app.post<{ Params: { id: string } }>('/v1/sessions/:id/cancel', async (request, reply) => {
    const body = request.body;
    if (!validateCancel(body)) return badRequest(reply);
    return sendResult(reply, await manager.handleCancel(request.params.id, body.request_id));
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
    const ollama = await modelReady(deps.llm);
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
    const outcome = applyReport(deps.repos, body, nowIso());
    deps.log.info({ event: 'execution_report', http_status: outcome });
    if (outcome === 204) return reply.code(204).send();
    return httpError(reply, outcome);
  });

  return app;
}
