import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contentDisposition } from '../../lib/http.js';
import type { ManualScoringService } from './manual.service.js';

const questionParams = z.object({ runTestId: z.string().uuid() });
const attachmentParams = z.object({ runTestId: z.string().uuid(), index: z.coerce.number().int().min(0).max(99) });
const runParams = z.object({ runId: z.string().uuid() });

const scoresBody = z
  .object({
    scores: z
      .array(
        z
          .object({
            letter: z.string().regex(/^[A-Z]{1,4}$/, 'Lettre invalide'),
            score: z.number().int().min(0).max(10),
            comment: z.string().trim().max(2000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(1000)
      .refine((s) => new Set(s.map((x) => x.letter)).size === s.length, 'Une lettre ne peut figurer qu\'une fois'),
  })
  .strict();

export function registerManualScoringRoutes(app: FastifyInstance, service: ManualScoringService): void {
  const admin = { preHandler: app.requireAdmin };
  const connected = { preHandler: app.requireActor };

  app.get('/api/scoring/todo', connected, async (req) => service.todo(req.actor!));

  app.get('/api/scoring/questions/:runTestId', connected, async (req) => {
    const { runTestId } = questionParams.parse(req.params);
    return service.question(req.actor!, runTestId);
  });

  app.put('/api/scoring/questions/:runTestId/manual', connected, async (req) => {
    const { runTestId } = questionParams.parse(req.params);
    return service.save(req.actor!, runTestId, scoresBody.parse(req.body).scores);
  });

  app.get('/api/scoring/questions/:runTestId/attachments/:index', connected, async (req, reply) => {
    const { runTestId, index } = attachmentParams.parse(req.params);
    const file = await service.attachment(runTestId, index);
    return reply
      .header('content-type', file.mime)
      .header('content-length', file.content.length)
      .header('content-disposition', contentDisposition(file.originalName))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(file.content);
  });

  app.get('/api/scoring/runs/:runId/spread', admin, async (req) => {
    const { runId } = runParams.parse(req.params);
    return service.spread(runId);
  });
}
