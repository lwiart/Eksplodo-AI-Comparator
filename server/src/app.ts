import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { AppConfig } from './config/config.js';
import { AppError } from './errors.js';
import type { Clock } from './lib/clock.js';
import { loggerOptions, type LogStream } from './plugins/logging.js';

// Étendu par les tâches suivantes : db, workerStatus (Task 2), mailer (Task 4), schedules (Task 6).
export type AppDeps = {
  config: AppConfig;
  clock: Clock;
  /**
   * Dossier de l'interface compilée ; défaut : `dist/web` sous la racine de l'application.
   * En environnement de test, aucune interface n'est servie sans `webRoot` explicite.
   */
  webRoot?: string;
  /** Flux de journal (tests) ; active le journal même en environnement de test. */
  logStream?: LogStream;
};

const TRUSTED_PROXY_HOPS = 1; // LiteSpeed chez Hostinger : exactement un relais de confiance

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

  return app;
}
