import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { AppConfig } from './config/config.js';
import type { Db } from './db/client.js';
import { AppError } from './errors.js';
import type { Clock } from './lib/clock.js';
import { describeError, loggableError } from './modules/errors/capture.js';
import { registerDashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { createDashboardService } from './modules/dashboard/dashboard.service.js';
import { registerErrorRoutes } from './modules/errors/errors.routes.js';
import { deferError, flushPendingErrors, reportError, reportedReference } from './modules/errors/report.js';
import type { ScheduleEntry } from './modules/jobs/scheduler.js';
import { registerTickRoutes } from './modules/jobs/tick.routes.js';
import { registerCatalogRoutes } from './modules/catalog/catalog.routes.js';
import { createCatalogService } from './modules/catalog/catalog.service.js';
import { registerManualScoringRoutes } from './modules/scoring/manual.routes.js';
import { registerResultsRoutes } from './modules/scoring/results.routes.js';
import { createResultsService } from './modules/scoring/results.service.js';
import { createManualScoringService } from './modules/scoring/manual.service.js';
import { registerScoringRoutes } from './modules/scoring/scoring.routes.js';
import { registerRunsRoutes } from './modules/runs/runs.routes.js';
import { registerPublicShareRoutes } from './modules/sharing/public.routes.js';
import { registerShareLinksRoutes } from './modules/sharing/share-links.routes.js';
import { createShareLinksService } from './modules/sharing/share-links.service.js';
import { createRunsService } from './modules/runs/runs.service.js';
import { MAX_ATTACHMENT_BYTES } from './modules/tests/attachments.js';
import { registerSuitesRoutes } from './modules/tests/suites.routes.js';
import { createSuitesService } from './modules/tests/suites.service.js';
import { createQuickTryService } from './modules/tests/quick-try.js';
import { registerTestsRoutes } from './modules/tests/tests.routes.js';
import { createTestsService } from './modules/tests/tests.service.js';
import type { Mailer } from './modules/mail/mailer.js';
import type { Registry } from './modules/providers/registry.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { createUsersService } from './modules/users/users.service.js';
import { registerUserRoutes } from './modules/users/users.routes.js';
import { registerAuth } from './plugins/auth.js';
import { registerCsrf } from './plugins/csrf.js';
import { loggerOptions, type LogStream } from './plugins/logging.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { DEFAULT_WEB_ROOT, registerStatic } from './plugins/static.js';

export type AppDeps = {
  config: AppConfig;
  clock: Clock;
  db: Db;
  mailer: Mailer;
  /** Registre des fournisseurs : choisit l'adaptateur et déchiffre les clés au moment de l'appel. */
  registry: Registry;
  /** Planification des tâches récurrentes (`/internal/tick` et boucle interne) ; `[]` en test. */
  schedules: ScheduleEntry[];
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
  const catalog = createCatalogService(deps);
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
        // 'unsafe-inline' pour les styles seulement : le verrouillage du défilement de Radix injecte un <style>.
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        // Hors production l'application tourne en HTTP local : pas de réécriture forcée en HTTPS.
        upgradeInsecureRequests: production ? [] : null,
      },
    },
    strictTransportSecurity: production ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 5, fieldSize: 1024, parts: 7 } });
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
    const known = reportedReference(err);
    // Journal applicatif : nom seulement (le message peut contenir des données) ; le détail masqué va au journal des erreurs.
    req.log.error({ err: { name: err instanceof Error ? err.name : 'UnknownError' } }, 'erreur inattendue');
    if (known !== null) {
      return reply.status(500).send({ error: { code: 'internal', message: 'Erreur interne du serveur', reference: known } });
    }
    const d = describeError(err);
    // Motif de route, jamais l'URL réelle (elle peut contenir des identifiants ou un jeton).
    const reference = await reportError(
      deps.db,
      {
        source: 'request',
        origin: `${req.method} ${req.routeOptions?.url ?? 'inconnue'}`,
        code: 'internal',
        httpStatus: 500,
        message: `${d.name} : ${d.message}`,
        stack: d.stack,
        severity: 'grave',
        userId: req.actor?.userId ?? null,
      },
      deps.clock(),
    );
    return reply.status(500).send({ error: { code: 'internal', message: 'Erreur interne du serveur', reference } });
  });

  // 503 seulement si la base est injoignable ; l'événement `db_unreachable` est mis en attente en mémoire (la base
  // ne répond pas) puis écrit dès qu'elle revient.
  app.get('/health', async (_req, reply) => {
    const down = () => {
      deferError(
        {
          source: 'request',
          origin: 'GET /health',
          code: 'db_unreachable',
          httpStatus: 503,
          message: 'Base de données injoignable',
          severity: 'grave',
        },
        deps.clock(),
      );
      return reply.status(503).send({ status: 'degraded', db: 'down' });
    };
    if (!(await checkDb(deps.db))) return down();
    await flushPendingErrors(deps.db); // la base répond : écrit l'événement de panne différé
    let configured: number;
    try {
      configured = await catalog.configuredCount();
    } catch {
      return down(); // la base a lâché entre la sonde et la lecture : même réponse que base injoignable
    }
    return { status: 'ok', db: 'ok', worker: deps.workerStatus?.() ?? 'stopped', providers: { configured } };
  });

  registerAuthRoutes(app, deps);
  registerUserRoutes(app, createUsersService(deps));
  registerCatalogRoutes(app, catalog);
  registerTestsRoutes(app, createTestsService(deps), deps, createQuickTryService(deps));
  registerSuitesRoutes(app, createSuitesService(deps));
  registerRunsRoutes(app, createRunsService(deps));
  registerScoringRoutes(app, deps);
  registerShareLinksRoutes(app, createShareLinksService(deps), deps);
  registerPublicShareRoutes(app, deps);
  registerManualScoringRoutes(app, createManualScoringService(deps));
  registerResultsRoutes(app, createResultsService(deps));
  registerDashboardRoutes(app, createDashboardService(deps));
  registerTickRoutes(app, deps);
  registerErrorRoutes(app, deps);

  // Interface compilée : après les routes d'API, pour que le repli SPA ne les masque pas.
  const webRoot = deps.webRoot ?? (deps.config.nodeEnv === 'test' ? undefined : DEFAULT_WEB_ROOT);
  if (webRoot !== undefined) await registerStatic(app, webRoot);

  return app;
}
