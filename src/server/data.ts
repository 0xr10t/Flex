import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DATA_RESOURCES, parseDataQuery, dataPage } from '@flex/protocol';
import type { SessionManagerDeps } from '../session/manager.js';
import { expandHome } from '../config/load.js';
import { readCreData, readReceived } from './data-snapshots.js';

export function registerDataRoutes(app: FastifyInstance, deps: SessionManagerDeps) {
  app.get('/v1/data', (_request, reply) =>
    reply.header('cache-control', 'no-store').send({ resources: DATA_RESOURCES }),
  );
  app.get<{ Params: { resource: string } }>('/v1/data/:resource', async (request, reply) => {
    const spec = DATA_RESOURCES.find((s) => s.resource === request.params.resource);
    if (!spec) return reply.code(404).send({ error: 'Unknown resource' });
    const query = parseDataQuery(request.query, spec);
    if (!query) return reply.code(400).send({ error: 'Invalid filters' });
    if (spec.sessionScoped && !deps.repos.db8.getSession(query.session_id!))
      return reply.code(404).send({ error: 'Session not found' });
    reply.header('cache-control', 'no-store');
    if (spec.source === 'agent') {
      if (!deps.repos.readData) return reply.code(503).send({ error: 'Data reader unavailable' });
      return deps.repos.readData(spec.resource, query);
    }
    if (spec.source === 'wallet') {
      try {
        if (!deps.exec.readData) throw new Error('wallet reader unavailable');
        return await deps.exec.readData(spec.resource, query);
      } catch {
        return dataPage(spec, query, [], 0, 'unavailable');
      }
    }
    const now = deps.clock?.().toMillis() ?? Date.now();
    if (spec.source === 'history') return readReceived(spec, query, deps.config, deps.history, now);
    return readCreData(spec, query, join(dirname(expandHome(deps.config.db.path)), 'cre-runner'), now);
  });
}
