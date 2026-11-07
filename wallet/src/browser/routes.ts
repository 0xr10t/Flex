import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BrowserWalletController, BrowserWalletError } from './controller.js';

export function registerBrowserWallet(app: FastifyInstance, controller: BrowserWalletController) {
  const session = randomBytes(32).toString('hex');
  const asset = (path: string, type: string, file: string, encoding?: 'utf8') =>
    [path, { type, body: readFileSync(new URL(file, import.meta.url), encoding) }] as [
      string,
      { type: string; body: string | Buffer },
    ];
  const assets = new Map([
    asset('/', 'text/html', './ui.html', 'utf8'),
    asset('/wallet.js', 'text/javascript', './ui.js', 'utf8'),
    asset('/wallet.css', 'text/css', './ui.css', 'utf8'),
    // Self-hosted so the page never reaches a font CDN (Archivo and JetBrains Mono, SIL OFL 1.1).
    asset('/fonts/archivo.woff2', 'font/woff2', './fonts/archivo.woff2'),
    asset('/fonts/jetbrains-mono.woff2', 'font/woff2', './fonts/jetbrains-mono.woff2'),
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
          "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
      if (req.params.action === 'account-upgrade') {
        await controller.accountUpgrade(req.body);
        return { ok: true };
      }
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
