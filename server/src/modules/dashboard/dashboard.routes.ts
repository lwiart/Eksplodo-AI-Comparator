import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DashboardService } from './dashboard.service.js';

const evolutionQuery = z.object({ suiteId: z.string().uuid() });

export function registerDashboardRoutes(app: FastifyInstance, service: DashboardService): void {
  const connected = { preHandler: app.requireActor };

  app.get('/api/dashboard', connected, async (req) => service.overview(req.actor!));

  app.get('/api/dashboard/evolution', connected, async (req) => {
    const { suiteId } = evolutionQuery.parse(req.query);
    return service.evolution(suiteId, req.actor!);
  });
}
