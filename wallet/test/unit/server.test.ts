import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { silentLogger } from '../../src/log.js';
import { buildApp } from '../../src/server/app.js';
import { Store } from '../../src/store/store.js';
import { tempDb } from '../support/temp-db.js';
import { ALEX, BASE, BOB, WALLET, envelope, payUsdc, requestId } from '../support/envelopes.js';
import { USDC } from '../../src/schemas/intent.v2.js';

const TOKEN = 'inbound-test-token';
let store: Store;
let app: FastifyInstance;
let accepted: number;

beforeEach(() => {
  store = new Store(tempDb());
  accepted = 0;
  app = buildApp({
    store,
    walletAddress: WALLET,
    inboundToken: TOKEN,
    chainIds: [BASE],
    executorChainIds: [],
    onAccepted: () => accepted++,
    log: silentLogger,
  });
});
afterEach(() => app.close());

const post = (body: unknown, key?: string, token: string | null = TOKEN) =>
  app.inject({
    method: 'POST',
    url: '/v1/intents',
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    payload: body as object,
  });

const good = () =>
  envelope([
    payUsdc(0, [
      [ALEX, '10'],
      [BOB, '20'],
    ]),
  ]);

describe('POST /v1/intents', () => {
  it('saves a good envelope before replying 202', async () => {
    const e = good();
    const res = await post(e, e.request_id);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ request_id: e.request_id, status: 'accepted' });
    expect(store.stepsOf(e.request_id).map((s) => s.status)).toEqual(['pending']);
    expect(accepted).toBe(1);
  });

  it.each([
    ['no token', null],
    ['a wrong token', 'wrong'],
    ['a token with the right start', `${TOKEN}x`],
  ])('refuses %s', async (_name, token) => {
    const e = good();
    const res = await post(e, e.request_id, token);
    expect(res.statusCode).toBe(401);
    expect(store.storedHash(e.request_id)).toBeNull();
    expect(accepted).toBe(0);
  });

  it('refuses a missing Idempotency-Key', async () => {
    expect((await post(good())).statusCode).toBe(400);
  });

  it('refuses a key that differs from the request_id', async () => {
    expect((await post(good(), requestId())).statusCode).toBe(400);
  });

  it('refuses a v1 envelope', async () => {
    const e = { ...good(), version: '1' };
    expect((await post(e, e.request_id)).statusCode).toBe(400);
  });

  it('refuses a broken JSON body, without repeating it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: { authorization: `Bearer ${TOKEN}`, 'idempotency-key': 'k', 'content-type': 'application/json' },
      payload: `{"amount": 123456, ${ALEX}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/123456|0x/);
  });

  it('refuses an envelope for another wallet, and saves nothing', async () => {
    const e = { ...good(), wallet_address: BOB };
    const res = await post(e, e.request_id);
    expect(res.statusCode).toBe(422);
    expect(store.storedHash(e.request_id)).toBeNull();
  });

  it('refuses a chain with no RPC set up', async () => {
    const i = {
      ...payUsdc(0, [[ALEX, '1']]),
      chain_id: 421614 as const,
      token_address: USDC[421614],
    };
    const e = envelope([i]);
    expect((await post(e, e.request_id)).statusCode).toBe(422);
  });

  it('refuses an autopay on a chain with no executor deployed, so nothing is half done', async () => {
    const cancel = {
      intent_id: 'l' as const,
      step: 0,
      autopay_id: 'ap_0123456789ab',
      chain_id: BASE,
      plan_id: `0x${'ab'.repeat(32)}` as const,
    };
    const e = envelope([cancel]);
    const res = await post(e, e.request_id);
    expect(res.statusCode).toBe(422);
    expect(store.storedHash(e.request_id)).toBeNull();
  });

  it('refuses what the verified plan refuses, with a message free of values', async () => {
    const e = envelope([
      payUsdc(0, [
        [ALEX, '10'],
        [ALEX, '20'],
      ]),
    ]);
    const res = await post(e, e.request_id);
    expect(res.statusCode).toBe(422);
    expect(res.json().message).not.toMatch(/0x|\d/);
  });

  it('never puts a number or address in any refusal', async () => {
    const e = good();
    const replies = await Promise.all([
      post({ ...e, version: '1' }, e.request_id),
      post({ ...e, wallet_address: BOB }, e.request_id),
      post(e, requestId()),
      post(e, e.request_id, 'wrong'),
    ]);
    for (const r of replies) {
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.json().message).not.toMatch(/0x|\d/);
    }
  });
});

describe('a repeated key (rule 7)', () => {
  it('returns the first answer and queues nothing new', async () => {
    const e = good();
    const first = await post(e, e.request_id);
    const second = await post(e, e.request_id);
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());
    expect(accepted).toBe(1);
    expect(store.stepsOf(e.request_id)).toHaveLength(1);
  });

  it('handles copies sent at the same time', async () => {
    const e = good();
    const replies = await Promise.all(Array.from({ length: 10 }, () => post(e, e.request_id)));
    expect(replies.every((r) => r.statusCode === 202)).toBe(true);
    expect(accepted).toBe(1);
  });

  it('matches whatever the key order', async () => {
    const e = good();
    await post(e, e.request_id);
    const reordered = Object.fromEntries(Object.entries(e).reverse());
    expect((await post(reordered, e.request_id)).statusCode).toBe(202);
    expect(accepted).toBe(1);
  });

  it('refuses the same key with different content', async () => {
    const e = good();
    await post(e, e.request_id);
    const other = { ...e, intents: [payUsdc(0, [[ALEX, '99']])] };
    expect((await post(other, e.request_id)).statusCode).toBe(409);
    expect(accepted).toBe(1);
  });
});
