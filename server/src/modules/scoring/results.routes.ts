import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contentDisposition } from '../../lib/http.js';
import type { ResultsService } from './results.service.js';

const idParams = z.object({ id: z.string().uuid() });
const answersParams = z.object({ id: z.string().uuid(), runTestId: z.string().uuid() });

export function registerResultsRoutes(app: FastifyInstance, service: ResultsService): void {
  const connected = { preHandler: app.requireActor };

  app.get('/api/runs/:id/ranking', connected, async (req) => {
    const { id } = idParams.parse(req.params);
    return service.ranking(id, req.actor!);
  });

  app.get('/api/runs/:id/answers/:runTestId', connected, async (req) => {
    const { id, runTestId } = answersParams.parse(req.params);
    return service.answers(id, runTestId, req.actor!);
  });

  app.get('/api/runs/:id/export.csv', connected, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { fileName, body } = await service.exportCsv(id, req.actor!);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', contentDisposition(fileName))
      .header('cache-control', 'private, no-store')
      .send(body);
  });
}
