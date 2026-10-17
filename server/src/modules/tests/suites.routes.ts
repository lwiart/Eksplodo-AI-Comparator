import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SuitesService } from './suites.service.js';

const idParams = z.object({ id: z.string().uuid() });

const suiteBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(5_000).nullable().optional(),
    testIds: z
      .array(z.string().uuid())
      .max(500)
      .refine((ids) => new Set(ids).size === ids.length, 'Un test ne peut figurer qu\'une fois dans la suite'),
  })
  .strict();

export function registerSuitesRoutes(app: FastifyInstance, service: SuitesService): void {
  const admin = { preHandler: app.requireAdmin };

  app.get('/api/suites', admin, async () => ({ suites: await service.list() }));

  app.get('/api/suites/:id', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return { suite: await service.get(id) };
  });

  app.post('/api/suites', admin, async (req, reply) => {
    const body = suiteBody.parse(req.body);
    return reply.status(201).send({ suite: await service.create(req.actor!, body) });
  });

  app.put('/api/suites/:id', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = suiteBody.parse(req.body);
    return { suite: await service.update(req.actor!, id, body) };
  });

  app.post('/api/suites/:id/duplicate', admin, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return reply.status(201).send({ suite: await service.duplicate(req.actor!, id) });
  });

  app.delete('/api/suites/:id', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return { outcome: await service.remove(req.actor!, id) };
  });
}
