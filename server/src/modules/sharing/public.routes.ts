import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { loadPublicShare } from './public-share.js';

const params = z.object({ token: z.string().min(1).max(200) });

/** Limite de la route publique : 60 requêtes par minute et par IP. */
export const PUBLIC_SHARE_RATE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } } as const;

/** `GET /share/:token` : sans session, hors `/api`, jamais mis en cache ni indexé. */
export function registerPublicShareRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.get('/share/:token', PUBLIC_SHARE_RATE_LIMIT, async (req, reply) => {
    const { token } = params.parse(req.params);
    const share = await loadPublicShare(deps.db, token);
    return reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex').send(share);
  });
}
