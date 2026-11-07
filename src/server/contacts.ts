import type { FastifyInstance } from 'fastify';
import type { ContactEdit, ContactsPage } from '@flex/protocol';
import { nameKey } from '../lexical/text.js';
import { checkAddress, isSelf } from '../recipients/address.js';
import { checkContactName } from '../recipients/names.js';
import type { SessionManagerDeps } from '../session/manager.js';

/** The app's UI-token hook protects both routes; the execution-report token cannot edit contacts. */
export function registerContactRoutes(app: FastifyInstance, deps: SessionManagerDeps): void {
  app.get('/v1/contacts', (request, reply) => {
    reply.header('cache-control', 'no-store');
    const query = request.query as Record<string, unknown>;
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (
      Object.keys(query).some((k) => !['limit', 'offset'].includes(k)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      return reply.code(400).send({ errors: ['pagination'] });
    if (!deps.repos.contacts) return reply.code(503).send({ errors: ['contacts_unavailable'] });
    const page = deps.repos.contacts.list(limit, offset);
    return {
      ...page,
      limit,
      offset,
      next_offset: offset + limit < page.total ? offset + limit : null,
      networks: deps.config.chains.map((c) => ({ chain_id: c.chain_id, name: c.name })),
    } satisfies ContactsPage;
  });
  app.patch<{ Params: { id: string } }>('/v1/contacts/:id', (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (
      !/^\d+$/.test(request.params.id) ||
      !Number.isSafeInteger(Number(request.params.id)) ||
      Number(request.params.id) < 1
    )
      return reply.code(400).send({ errors: ['id'] });
    const book = deps.repos.contacts;
    if (!book) return reply.code(503).send({ errors: ['contacts_unavailable'] });
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ errors: ['body'] });
    const draft = body as Record<string, unknown>;
    const errors: string[] = [];
    if (Object.keys(draft).some((k) => !['name', 'address', 'chain_ids', 'version'].includes(k)))
      errors.push('unknown_field');
    if (typeof draft.name !== 'string') errors.push('name');
    if (typeof draft.address !== 'string') errors.push('address');
    if (typeof draft.version !== 'string' || !/^[a-f0-9]{64}$/.test(draft.version)) errors.push('version');
    const chains = draft.chain_ids;
    if (
      !Array.isArray(chains) ||
      !chains.length ||
      new Set(chains).size !== chains.length ||
      chains.some((id) => !deps.config.chains.some((c) => c.chain_id === id))
    )
      errors.push('chain_ids');
    if (errors.length) return reply.code(400).send({ errors });
    const current = book.get(Number(request.params.id));
    if (!current) return reply.code(404).send({ errors: ['not_found'] });
    const name = checkContactName(draft.name as string, deps.config, deps.repos, nameKey(current.name));
    if (!name.ok)
      return reply
        .code(name.reason === 'taken' ? 409 : 400)
        .send({ errors: [name.reason === 'taken' ? 'name_taken' : 'name'] });
    const address = checkAddress(draft.address as string);
    if (!address.ok || isSelf(address.address, deps.config.wallet.address))
      return reply.code(400).send({ errors: ['address'] });
    const result = book.edit(current.id, {
      ...draft,
      name: name.name,
      address: address.address,
    } as unknown as ContactEdit);
    if (!result.ok) return reply.code(result.reason === 'not_found' ? 404 : 409).send({ errors: [result.reason] });
    return result.contact;
  });
}
