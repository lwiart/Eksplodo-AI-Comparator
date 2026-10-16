import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { AppConfig } from './config/config.js';
import type { Db } from './db/client.js';
import { AppError } from './errors.js';
import type { Clock } from './lib/clock.js';
import type { Mailer } from './modules/mail/mailer.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { createUsersService } from './modules/users/users.service.js';
import { registerUserRoutes } from './modules/users/users.routes.js';
import { registerAuth } from './plugins/auth.js';
import { registerCsrf } from './plugins/csrf.js';
import { loggerOptions, type LogStream } from './plugins/logging.js';
import { registerRateLimit } from './plugins/rate-limit.js';

// Étendu par les tâches suivantes : schedules (Task 6).
export type AppDeps = {
  config: AppConfig;
  clock: Clock;
  db: Db;
  mailer: Mailer;
  /** État du worker de tâches, lu à chaque appel de `/health` (absent : `stopped`). */
  workerStatus?: () => 'running' | 'stopped';
  /**
   * Dossier de l'interface compilée ; défaut : `dist/web` sous la racine de l'application.
   * En environnement de test, aucune interface n'est servie sans `webRoot` explicite.
   */
  webRoot?: string;
  /** Flux de journal (tests) ; active le journal même en environnement de test. */
  logStream?: LogStream;
};

const HEALTH_DB_TIMEOUT_MS = 2000;
const TRUSTED_PROXY_HOPS = 1; // LiteSpeed chez Hostinger : exactement un relais de confiance

/** Promesse bornée à HEALTH_DB_TIMEOUT_MS (rejet `timeout` au-delà). */
async function withHealthTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), HEALTH_DB_TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkDb(db: Db): Promise<boolean> {
  try {
    await withHealthTimeout(db.execute(sql`SELECT 1`));
    return true;
  } catch {
    return false;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(deps.config.nodeEnv, deps.logStream),
    // Équivaut à `trustProxy: 1` (le type Fastify n'accepte pas le nombre) ; `true` rendrait l'IP falsifiable via X-Forwarded-For.
    trustProxy: (_address, hop) => hop < TRUSTED_PROXY_HOPS,
  });

  const production = deps.config.nodeEnv === 'production';
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        // Hors production l'application tourne en HTTP local : pas de réécriture forcée en HTTPS.
        upgradeInsecureRequests: production ? [] : null,
      },
    },
    strictTransportSecurity: production ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await app.register(cookie);
  await registerRateLimit(app);
  registerCsrf(app, deps.config);
  registerAuth(app, deps);

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: 'Ressource introuvable' } });
  });

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { ...err.extra, code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join('.') || 'requête'} : ${i.message}`).join('; ');
      return reply.status(400).send({ error: { code: 'validation', message } });
    }
    // Erreurs 4xx émises par Fastify (JSON malformé, corps trop grand, etc.)
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request', message: 'Requête invalide' } });
    }
    // Seul le nom de l'erreur est journalisé : le message peut contenir des données (le journal des erreurs arrive en Task 6).
    req.log.error({ err: { name: err instanceof Error ? err.name : 'UnknownError' } }, 'erreur inattendue');
    return reply.status(500).send({ error: { code: 'internal', message: 'Erreur interne du serveur' } });
  });

  // 503 seulement si la base est injoignable (le report de l'erreur `db_unreachable` est branché en Task 6).
  app.get('/health', async (_req, reply) => {
    if (!(await checkDb(deps.db))) {
      return reply.status(503).send({ status: 'degraded', db: 'down' });
    }
    return { status: 'ok', db: 'ok', worker: deps.workerStatus?.() ?? 'stopped' };
  });

  registerAuthRoutes(app, deps);
  registerUserRoutes(app, createUsersService(deps));

  return app;
}
