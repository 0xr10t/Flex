import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { getAddress, isAddress, zeroAddress } from 'viem';
import { openLocalPageAsync } from '../open.js';

export class WalletConnectError extends Error {
  constructor(readonly reason: 'cancelled' | 'timeout' | 'browser' | 'setup') {
    super(
      {
        cancelled: 'Wallet connection cancelled. Send a message to try again.',
        timeout: 'Wallet connection expired. Send a message to open MetaMask again.',
        browser: 'Could not open your default browser. Run flexx from a desktop terminal and try again.',
        setup: 'Wallet address saved. Complete the remaining settings with npm run testnet:setup.',
      }[reason],
    );
    this.name = 'WalletConnectError';
  }
}

export function walletAddress(value: unknown): string | undefined {
  if (typeof value !== 'string' || !isAddress(value, { strict: false }) || value.toLowerCase() === zeroAddress)
    return undefined;
  return getAddress(value);
}

export interface ConnectOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  openPage?: (url: string) => Promise<boolean>;
}

/** A short-lived, capability-protected loopback callback. It accepts only a public address, never signatures. */
export async function startWalletConnectServer(opts: Pick<ConnectOptions, 'signal' | 'timeoutMs'> = {}) {
  if (opts.signal?.aborted) throw new WalletConnectError('cancelled');
  const app = Fastify({ logger: false, bodyLimit: 1024, ajv: { customOptions: { removeAdditional: false } } });
  const token = randomBytes(32).toString('hex');
  let origin = '';
  let settled = false;
  let accept!: (address: string) => void;
  let reject!: (error: Error) => void;
  const address = new Promise<string>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  void address.catch(() => {});
  const cancel = (reason: 'cancelled' | 'timeout') => {
    if (!settled) {
      settled = true;
      reject(new WalletConnectError(reason));
    }
  };
  const abort = () => cancel('cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;

  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-security-policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
    if (`http://${req.headers.host}` !== origin) return reply.code(403).send({ error: 'LOCAL_SESSION_REQUIRED' });
    if (req.method === 'POST') {
      const supplied = req.headers['x-flex-connect'];
      if (
        req.headers.origin !== origin ||
        typeof supplied !== 'string' ||
        !/^[0-9a-f]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      )
        return reply.code(403).send({ error: 'LOCAL_SESSION_REQUIRED' });
    }
  });
  for (const [path, file, type] of [
    ['/', 'index.html', 'text/html'],
    ['/connect.js', 'connect.js', 'text/javascript'],
    ['/connect.css', 'connect.css', 'text/css'],
  ]) {
    const body = readFileSync(new URL(`./page/${file}`, import.meta.url), 'utf8');
    app.get(path!, async (_req, reply) => reply.type(type!).send(body));
  }
  app.post<{ Body: { address: string } }>(
    '/connect',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['address'],
          properties: { address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } },
        },
      },
    },
    async (req, reply) => {
      if (settled) return reply.code(409).send({ error: 'CONNECTION_FINISHED' });
      const selected = walletAddress(req.body.address);
      if (!selected) return reply.code(400).send({ error: 'INVALID_ADDRESS' });
      settled = true;
      reply.send({ ok: true });
      accept(selected);
      return reply;
    },
  );
  app.post('/cancel', async (_req, reply) => {
    reply.send({ ok: true });
    cancel('cancelled');
    return reply;
  });
  app.setErrorHandler((_error, _req, reply) => reply.code(400).send({ error: 'INVALID_REQUEST' }));
  try {
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    timer = setTimeout(() => cancel('timeout'), opts.timeoutMs ?? 5 * 60_000);
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();
  } catch (error) {
    await app.close();
    throw error;
  }
  return {
    url: `${origin}/#connect=${token}`,
    address,
    async close() {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      cancel('cancelled');
      await app.close();
    },
  };
}

export async function connectMetaMask(opts: ConnectOptions = {}): Promise<string> {
  const server = await startWalletConnectServer(opts);
  try {
    if (!(await (opts.openPage ?? openLocalPageAsync)(server.url))) throw new WalletConnectError('browser');
    return await server.address;
  } finally {
    await server.close();
  }
}
