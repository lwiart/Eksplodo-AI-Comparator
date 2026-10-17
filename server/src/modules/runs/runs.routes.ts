import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RunsService } from './runs.service.js';

const idParams = z.object({ id: z.string().uuid() });

const unique = (ids: string[]) => new Set(ids).size === ids.length;
const weight = z.number().int().min(0).max(100);
/** Plafond stocké en `DECIMAL(10,4)` : précision au dix-millième, jamais arrondi à zéro. */
const BUDGET_STEP = 0.0001;

const runBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    suiteId: z.string().uuid().optional(),
    testIds: z.array(z.string().uuid()).min(1).max(500).refine(unique, 'Un test ne peut figurer qu\'une fois dans la série'),
    modelIds: z.array(z.string().uuid()).min(1).max(50).refine(unique, 'Un modèle ne peut figurer qu\'une fois dans la série'),
    repetitions: z.number().int().min(1).max(5).default(1),
    concurrency: z.number().int().min(1).max(8).default(4),
    judgeModelId: z.string().uuid().nullable().optional(),
    budgetUsd: z
      .number()
      .min(BUDGET_STEP)
      .max(999_999)
      .refine((v) => Math.abs(v / BUDGET_STEP - Math.round(v / BUDGET_STEP)) < 1e-6, 'Plafond : 4 décimales au plus')
      .nullable()
      .optional(),
    weights: z
      .object({ quality: weight, speed: weight, cost: weight, reliability: weight })
      .strict()
      .refine((w) => w.quality + w.speed + w.cost + w.reliability === 100, 'La somme des pondérations doit valoir 100')
      .optional(),
  })
  .strict();

export function registerRunsRoutes(app: FastifyInstance, service: RunsService): void {
  const admin = { preHandler: app.requireAdmin };
  const connected = { preHandler: app.requireActor };

  app.post('/api/runs/estimate', admin, async (req) => ({ estimate: await service.estimate(runBody.parse(req.body)) }));

  app.post('/api/runs', admin, async (req, reply) => {
    const body = runBody.parse(req.body);
    return reply.status(201).send({ run: await service.create(req.actor!, body) });
  });

  app.get('/api/runs', connected, async () => ({ runs: await service.list() }));

  app.get('/api/runs/:id', connected, async (req) => {
    const { id } = idParams.parse(req.params);
    return { run: await service.get(id) };
  });

  app.get('/api/runs/:id/progress', connected, async (req) => {
    const { id } = idParams.parse(req.params);
    return { progress: await service.progress(id) };
  });

  app.get('/api/runs/:id/results', connected, async (req) => {
    const { id } = idParams.parse(req.params);
    return { results: await service.results(id) };
  });
}
