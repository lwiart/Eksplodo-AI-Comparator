import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client.js';
import { loadPublicShare, shareNotFound } from './public-share.js';

/** Forme d'un jeton (base64url, 32 caractères en pratique) : tout autre jeton reçoit le même 404 uniforme. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** Limite de la route publique : 60 requêtes par minute et par IP. */
export const PUBLIC_SHARE_RATE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } } as const;

/** `GET /share/:token` : sans session, hors `/api` ; jamais mis en cache ni indexé, erreurs comprises. */
export function registerPublicShareRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.get(
    '/share/:token',
    {
      ...PUBLIC_SHARE_RATE_LIMIT,
      onSend: async (_req, reply, payload) => {
        reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex');
        return payload;
      },
    },
    async (req) => {
      const { token } = req.params as { token: string };
      if (!TOKEN_SHAPE.test(token)) throw shareNotFound();
      return loadPublicShare(deps.db, token);
    },
  );
}
