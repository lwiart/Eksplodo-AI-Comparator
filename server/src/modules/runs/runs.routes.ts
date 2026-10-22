import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RunsService } from './runs.service.js';

const idParams = z.object({ id: z.string().uuid() });

const unique = (ids: string[]) => new Set(ids).size === ids.length;
const weight = z.number().int().min(0).max(100);
/** Plafond stocké en `DECIMAL(10,4)` : précision au dix-millième, jamais arrondi à zéro. */
const BUDGET_STEP = 0.0001;

const budgetUsd = z
  .number()
  .min(BUDGET_STEP)
  .max(999_999)
  .refine((v) => Math.abs(v / BUDGET_STEP - Math.round(v / BUDGET_STEP)) < 1e-6, 'Plafond : 4 décimales au plus')
  .nullable()
  .optional();
const weights = z
  .object({ quality: weight, speed: weight, cost: weight, reliability: weight })
  .strict()
  .refine((w) => w.quality + w.speed + w.cost + w.reliability === 100, 'La somme des pondérations doit valoir 100')
  .optional();
const modelIds = z.array(z.string().uuid()).min(1).max(50).refine(unique, 'Un modèle ne peut figurer qu\'une fois dans la série');

/** Nom d'une série : mêmes bornes à la création et au renommage. */
const runName = z.string().trim().min(1).max(200);

const runBody = z
  .object({
    name: runName,
    suiteId: z.string().uuid().optional(),
    testIds: z.array(z.string().uuid()).min(1).max(500).refine(unique, 'Un test ne peut figurer qu\'une fois dans la série'),
    modelIds,
    repetitions: z.number().int().min(1).max(5).default(1),
    concurrency: z.number().int().min(1).max(8).default(4),
    judgeModelId: z.string().uuid().nullable().optional(),
    budgetUsd,
    weights,
  })
  .strict();

const addModelsBody = z.object({ modelIds }).strict();
const addTestsBody = z
  .object({ testIds: z.array(z.string().uuid()).min(1).max(500).refine(unique, 'Un test ne peut figurer qu’une fois dans la série') })
  .strict();
const rescoreBody = z
  .object({
    scope: z.enum(['run', 'test', 'result']),
    runTestId: z.string().uuid().optional(),
    resultId: z.string().uuid().optional(),
    judgeModelId: z.string().uuid().optional(),
  })
  .strict()
  .refine((b) => b.scope !== 'test' || b.runTestId !== undefined, { message: 'runTestId requis pour recalculer un test', path: ['runTestId'] })
  .refine((b) => b.scope !== 'result' || b.resultId !== undefined, { message: 'resultId requis pour recalculer un résultat', path: ['resultId'] });
const rerunBody = z
  .object({
    resultIds: z.array(z.string().uuid()).min(1).max(5_000).refine(unique, 'Un résultat ne peut figurer qu’une fois'),
    refreshMaxTokens: z.boolean().default(true),
  })
  .strict();
const patchBody = z
  .object({ name: runName.optional(), budgetUsd, weights })
  .strict()
  .refine((b) => b.name !== undefined || b.budgetUsd !== undefined || b.weights !== undefined, 'Aucune modification demandée');

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

  app.patch('/api/runs/:id', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return { run: await service.update(req.actor!, id, patchBody.parse(req.body)) };
  });

  app.post('/api/runs/:id/pause', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return { run: await service.pause(req.actor!, id) };
  });

  app.post('/api/runs/:id/resume', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return { run: await service.resume(req.actor!, id) };
  });

  app.post('/api/runs/:id/retry-errors', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return { run: await service.retryErrors(req.actor!, id) };
  });

  app.post('/api/runs/:id/cancel-pending', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    const { cancelled, ...run } = await service.cancelPending(req.actor!, id);
    return { run, cancelled };
  });

  app.post('/api/runs/:id/rerun', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    const { rerun, ...run } = await service.rerunResults(req.actor!, id, rerunBody.parse(req.body));
    return { run, rerun };
  });

  app.post('/api/runs/:id/models', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return { run: await service.addModels(req.actor!, id, addModelsBody.parse(req.body).modelIds) };
  });

  app.get('/api/runs/:id/missing-suite-tests', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return { tests: await service.missingSuiteTests(id) };
  });

  app.post('/api/runs/:id/tests', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    const { addedTests, ...run } = await service.addTests(req.actor!, id, addTestsBody.parse(req.body).testIds);
    return { run, addedTests };
  });

  app.delete('/api/runs/:id/models/:modelId', admin, async (req) => {
    const { id, modelId } = z.object({ id: z.string().uuid(), modelId: z.string().uuid() }).parse(req.params);
    const { removedResults, ...run } = await service.removeModel(req.actor!, id, modelId);
    return { run, removedResults };
  });

  app.delete('/api/runs/:id', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return service.remove(req.actor!, id);
  });

  app.post('/api/runs/:id/rescore', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return service.rescore(req.actor!, id, rescoreBody.parse(req.body));
  });

  app.get('/api/runs/:id/progress', connected, async (req) => {
    const { id } = idParams.parse(req.params);
    return { progress: await service.progress(id, req.actor!) };
  });

  app.get('/api/runs/:id/results', connected, async (req) => {
    const { id } = idParams.parse(req.params);
    return { results: await service.results(id, req.actor!) };
  });
}
