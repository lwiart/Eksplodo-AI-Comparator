import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/config.js';
import { AppError } from '../errors.js';

export const CSRF_COOKIE = 'aic_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

class CsrfError extends AppError {
  constructor() {
    super('csrf', 403, 'Jeton CSRF invalide ou manquant');
  }
}

function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function registerCsrf(app: FastifyInstance, config: AppConfig): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.cookies[CSRF_COOKIE]) {
      const value = randomBytes(32).toString('base64url');
      reply.setCookie(CSRF_COOKIE, value, {
        httpOnly: false,
        sameSite: 'lax',
        secure: config.nodeEnv === 'production',
        path: '/',
      });
    }
    // Décision d'après la route appariée (pas l'URL brute, qui peut contenir des échappements %61pi).
    const routeUrl = req.routeOptions.url ?? '';
    const exempt = SAFE_METHODS.has(req.method) || routeUrl.startsWith('/internal/');
    if (!exempt && !safeEqual(req.headers['x-csrf-token'], req.cookies[CSRF_COOKIE])) throw new CsrfError();
  });
}
