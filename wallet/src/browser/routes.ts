import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BrowserWalletController, BrowserWalletError } from './controller.js';

export function registerBrowserWallet(app: FastifyInstance, controller: BrowserWalletController) {
  const session = randomBytes(32).toString('hex');
  const assets = new Map([
    ['/', { type: 'text/html', body: readFileSync(new URL('./ui.html', import.meta.url), 'utf8') }],
    ['/wallet.js', { type: 'text/javascript', body: readFileSync(new URL('./ui.js', import.meta.url), 'utf8') }],
    ['/wallet.css', { type: 'text/css', body: readFileSync(new URL('./ui.css', import.meta.url), 'utf8') }],
  ]);
  const local = (request: FastifyRequest) => /^127\.0\.0\.1:\d+$/.test(request.headers.host ?? '');
  const authenticated = (request: FastifyRequest) => {
    const cookie = request.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('flex_wallet='))
      ?.slice(12);
    return (
      local(request) &&
      request.headers['x-flex-wallet'] === '1' &&
      cookie?.length === session.length &&
      timingSafeEqual(Buffer.from(cookie), Buffer.from(session)) &&
      (!request.headers.origin || request.headers.origin === `http://${request.headers.host}`)
    );
  };
  for (const [path, asset] of assets)
    app.get(path, (req, reply) => {
      if (!local(req)) return reply.code(403).send();
      reply
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .header(
          'content-security-policy',
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
      if (path === '/') reply.header('set-cookie', `flex_wallet=${session}; HttpOnly; SameSite=Strict; Path=/`);
      return reply.type(asset.type).send(asset.body);
    });
  app.get('/browser/state', (req, reply) => {
    if (!authenticated(req)) return reply.code(403).send({ error: 'LOCAL_SESSION_REQUIRED' });
    return reply.header('cache-control', 'no-store').send(controller.state());
  });
  app.post<{
    Params: { action: string };
    Body: { id?: string; walletId?: unknown; result?: unknown; hash?: unknown; signature?: unknown };
  }>('/browser/:action', async (req, reply) => {
    if (!authenticated(req) || req.headers.origin !== `http://${req.headers.host}`)
      return reply.code(403).send({ error: 'LOCAL_SESSION_REQUIRED' });
    try {
      if (req.params.action === 'bridge') return { requestId: controller.createBridge(req.body) };
      const id = req.body?.id;
      if (typeof id !== 'string' || !/^0x[0-9a-f]{64}$/.test(id))
        return reply.code(400).send({ error: 'INVALID_BATCH' });
      switch (req.params.action) {
        case 'delegation':
          await controller.delegation(id, req.body.signature);
          break;
        case 'reject-delegation':
          await controller.delegation(id, undefined, true);
          break;
        case 'wallet-id':
          controller.rememberWalletId(id, req.body.walletId);
          break;
        case 'claim':
          return { calls: controller.claim(id) };
        case 'refresh':
          controller.refresh(id);
          break;
        case 'reject':
          controller.reject(id);
          break;
        case 'receipt':
          await controller.receive(id, req.body.result);
          break;
        case 'recover':
          await controller.recover(id, req.body.hash);
          break;
        default:
          return reply.code(404).send({ error: 'UNKNOWN_ACTION' });
      }
      return { ok: true };
    } catch (e) {
      if (e instanceof BrowserWalletError) return reply.code(409).send({ error: e.code });
      return reply.code(503).send({ error: 'VERIFICATION_UNAVAILABLE' });
    }
  });
}
