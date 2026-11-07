// Implements: §14.2 (POST /v1/intents: 2xx accepted; 4xx with { message } shown to the user; 5xx means try again), rule 7
// (a repeated Idempotency-Key returns the original result) and §15 (messages hold no amounts or addresses).
//
// The envelope is saved before the 202, and it runs after the reply, because signing can take far longer than the agent's
// 15 s timeout. The checks and the save happen with no await between them, so two copies of a request can't both pass.

import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Hex } from 'viem';
import type { Logger } from '../log.js';
import { checkEnvelope } from '@flex/protocol/mapping/check';
import { placeholderHashes } from '@flex/protocol/mapping/to-plan';
import { validateEnvelope, type HandoffEnvelope } from '@flex/protocol/schemas/envelope';
import { envelopeHash, type Store } from '../store/store.js';

export interface AppDeps {
  store: Store;
  walletAddress: Hex;
  inboundToken: string;
  /** Chains this wallet has an RPC for. */
  chainIds: readonly number[];
  /** Chains with an executor deployed. Autopay and cancel can't work without one. */
  executorChainIds: readonly number[];
  onAccepted: () => void;
  log: Logger;
  now?: () => Date;
}

const MESSAGE = {
  unauthorized: 'the wallet did not accept the credentials of this request.',
  badRequest: 'the request has a format the wallet does not accept.',
  conflict: 'this request id was already used for a different request.',
  unsupported: 'the wallet cannot do this kind of request yet.',
  otherWallet: 'this request is for a different wallet.',
  unknownChain: 'this request uses a chain the wallet is not set up for.',
  internal: 'the wallet hit an internal problem.',
} as const;

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(token));
}

const chainsOf = (envelope: HandoffEnvelope): number[] =>
  envelope.intents.flatMap((x) => (x.intent_id === 'j' ? [x.source_chain_id, x.dest_chain_id] : [x.chain_id]));

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const now = deps.now ?? (() => new Date());

  // Fastify's own error text can repeat parts of the input, so nothing from it reaches the reply.
  app.setErrorHandler((error: { statusCode?: number }, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      deps.log('intake_error', { http_status: status });
      return reply.code(500).send({ message: MESSAGE.internal });
    }
    return reply.code(400).send({ message: MESSAGE.badRequest });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ message: MESSAGE.badRequest }));

  app.get('/v1/health', (request, reply) => {
    if (!tokenMatches(request.headers.authorization, deps.inboundToken))
      return reply.code(401).send({ message: MESSAGE.unauthorized });
    const db = deps.store.readable();
    return reply
      .header('cache-control', 'no-store')
      .code(db ? 200 : 503)
      .send({
        service: 'flex-wallet',
        ok: db,
        db,
        wallet_address: deps.walletAddress,
      });
  });

  app.post('/v1/intents', (request, reply) => {
    if (!tokenMatches(request.headers.authorization, deps.inboundToken)) {
      return reply.code(401).send({ message: MESSAGE.unauthorized });
    }
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string') return reply.code(400).send({ message: MESSAGE.badRequest });

    const accepted = () => reply.code(202).send({ request_id: key, status: 'accepted' });

    // Rule 7 comes first: a repeat gets the first answer, even if a time-based check would now say something else.
    const stored = deps.store.storedHash(key);
    if (stored !== null) {
      if (stored === envelopeHash(request.body)) return accepted();
      return reply.code(409).send({ message: MESSAGE.conflict });
    }

    const shape = validateEnvelope(request.body);
    if (!shape.ok) {
      deps.log('intake_rejected', { stage: 'schema' });
      return reply.code(400).send({ message: MESSAGE.badRequest });
    }
    const envelope = shape.envelope;
    if (envelope.request_id !== key) return reply.code(400).send({ message: MESSAGE.badRequest });

    const refuse = (stage: string, message: string) => {
      deps.log('intake_rejected', { request_id: key, stage });
      return reply.code(422).send({ message });
    };
    if (envelope.wallet_address.toLowerCase() !== deps.walletAddress.toLowerCase()) {
      return refuse('wallet', MESSAGE.otherWallet);
    }
    if (chainsOf(envelope).some((c) => !deps.chainIds.includes(c))) return refuse('chain', MESSAGE.unknownChain);

    // Refused up front, so a plan can't pay part of the way and then stop at a step this wallet can't do.
    const needsExecutor = envelope.intents.flatMap((x) =>
      x.intent_id === 'k' || x.intent_id === 'l' ? [x.chain_id] : [],
    );
    if (needsExecutor.some((c) => !deps.executorChainIds.includes(c)))
      return refuse('unsupported', MESSAGE.unsupported);

    const checked = checkEnvelope(envelope, { nowMs: now().getTime(), delegationHashes: placeholderHashes(envelope) });
    if (!checked.ok) return refuse(checked.stage, checked.message);

    deps.store.insertRequest(envelope, now().toISOString());
    deps.onAccepted();
    return accepted();
  });

  return app;
}
