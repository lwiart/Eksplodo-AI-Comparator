import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { setOverride } from './override.js';
import { getDefaultJudge, setDefaultJudge } from './settings.js';

const idParams = z.object({ id: z.string().uuid() });
const settingsBody = z.object({ defaultJudgeModelId: z.string().uuid().nullable() }).strict();
const overrideBody = z.object({ score: z.number().nullable() }).strict();

export function registerScoringRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const admin = { preHandler: app.requireAdmin };

  app.get('/api/settings/scoring', admin, async () => ({ defaultJudgeModelId: await getDefaultJudge(deps.db) }));

  app.put('/api/settings/scoring', admin, async (req) => {
    const body = settingsBody.parse(req.body);
    return { defaultJudgeModelId: await setDefaultJudge(deps.db, req.actor!, body.defaultJudgeModelId) };
  });

  app.put('/api/scoring/results/:id/override', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    const { score } = overrideBody.parse(req.body);
    return { result: await setOverride(deps.db, req.actor!, id, score) };
  });
}
