import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/config.js';
import type { Db } from '../db/client.js';
import { UnauthorizedError } from '../errors.js';
import type { Clock } from '../lib/clock.js';
import { assertRole, type Actor } from '../modules/auth/actor.js';
import { SESSION_TTL_MS, resolveSessionDetailed } from '../modules/auth/sessions.js';

export const SESSION_COOKIE = 'aic_session';

export function sessionCookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.nodeEnv === 'production',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
  interface FastifyInstance {
    requireActor: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function registerAuth(app: FastifyInstance, deps: { config: AppConfig; db: Db; clock: Clock }): void {
  app.decorateRequest('actor', null);
  app.addHook('onRequest', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const resolved = token ? await resolveSessionDetailed(deps.db, token, deps.clock()) : null;
    req.actor = resolved?.actor ?? null;
    // Expiration glissante côté navigateur : renvoyer le cookie quand la session est prolongée.
    if (resolved?.extendedTo && token) reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(deps.config));
  });
  app.decorate('requireActor', async (req: FastifyRequest) => {
    if (!req.actor) throw new UnauthorizedError();
  });
  app.decorate('requireAdmin', async (req: FastifyRequest) => {
    if (!req.actor) throw new UnauthorizedError();
    assertRole(req.actor, 'admin');
  });
}
