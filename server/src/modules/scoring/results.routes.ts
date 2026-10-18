import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contentDisposition, wantsInline } from '../../lib/http.js';
import type { ResultsService } from './results.service.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const idParams =z.object({ id: z.string().uuid() });
const answersParams = z.object({ id: z.string().uuid(), runTestId: z.string().uuid() });
const attachmentParams = answersParams.extend({ index: z.coerce.number().int().min(0).max(99) });

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

  app.get('/api/runs/:id/answers/:runTestId/attachments/:index', connected, async (req, reply) => {
    const { id, runTestId, index } = attachmentParams.parse(req.params);
    const file = await service.attachment(id, runTestId, index);
    return reply
      .header('content-type', file.mime)
      .header('content-length', file.content.length)
      .header('content-disposition', contentDisposition(file.originalName, wantsInline(req.query, file.mime)))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(file.content);
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

  app.get('/api/runs/:id/export.xlsx', connected, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { fileName, body } = await service.exportXlsx(id, req.actor!);
    return reply
      .header('content-type', XLSX_MIME)
      .header('content-disposition', contentDisposition(fileName))
      .header('cache-control', 'private, no-store')
      .send(body);
  });
}
