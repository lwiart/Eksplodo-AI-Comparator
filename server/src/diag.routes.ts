// TEMPORAIRE : route de diagnostic pour les vérifications de la spec §16 (coupure des requêtes longues par
// LiteSpeed, mémoire au repos). À supprimer après la recette : ce fichier et l'appel dans `app.ts`.
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from './app.js';
import { UnauthorizedError } from './errors.js';
import { secretMatches } from './modules/jobs/tick.routes.js';

const MAX_WAIT_SECONDS = 120;
const querySchema = z.object({ waitSeconds: z.coerce.number().int().min(0).max(MAX_WAIT_SECONDS).default(0) });

export function registerDiagRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/internal/diag', async (req) => {
    if (!secretMatches(req.headers['x-cron-secret'], deps.config.cronSecret)) throw new UnauthorizedError();
    const { waitSeconds } = querySchema.parse(req.query);
    if (waitSeconds > 0) await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    const [rows] = (await deps.db.execute(sql`SELECT VERSION() AS v`)) as unknown as [Array<{ v: string }>];
    return {
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      mariadbVersion: rows[0]?.v ?? 'inconnue',
    };
  });
}
