import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import {
  createShareLinkBody,
  getAuditUrl,
  setAuditUrl,
  updateShareLinkBody,
  type ShareLinksService,
} from './share-links.service.js';

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({ runId: z.string().uuid().optional() });
const auditUrlBody = z.object({ auditUrl: z.string() }).strict();

export function registerShareLinksRoutes(app: FastifyInstance, service: ShareLinksService, deps: { db: Db }): void {
  const admin = { preHandler: app.requireAdmin };

  app.get('/api/share-links', admin, async (req) => {
    const { runId } = listQuery.parse(req.query);
    return { links: await service.list(runId) };
  });

  app.post('/api/share-links', admin, async (req, reply) => {
    const body = createShareLinkBody.parse(req.body);
    return reply.status(201).send(await service.create(req.actor!, body));
  });

  app.patch('/api/share-links/:id', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return { link: await service.update(req.actor!, id, updateShareLinkBody.parse(req.body)) };
  });

  // Jeton en clair d'un lien existant (Admin), pour recopier le lien sans le régénérer ; jamais mis en cache.
  app.get('/api/share-links/:id/token', admin, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    reply.header('cache-control', 'no-store');
    return { token: await service.token(id) };
  });

  app.post('/api/share-links/:id/regenerate', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return service.regenerate(req.actor!, id);
  });

  app.delete('/api/share-links/:id', admin, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    await service.remove(req.actor!, id);
    return reply.status(204).send();
  });

  app.get('/api/settings/sharing', admin, async () => ({ auditUrl: await getAuditUrl(deps.db) }));

  app.put('/api/settings/sharing', admin, async (req) => {
    const { auditUrl } = auditUrlBody.parse(req.body);
    return { auditUrl: await setAuditUrl(deps.db, req.actor!, auditUrl) };
  });
}
