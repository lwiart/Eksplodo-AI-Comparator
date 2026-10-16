import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { buildApp } from './app.js';
import { configWarnings, loadConfig } from './config/config.js';
import { createDb } from './db/client.js';
import { reportingMailer } from './modules/errors/mail-reporter.js';
import { createGraveListener } from './modules/errors/notifications.js';
import { setGraveListener } from './modules/errors/report.js';
import { createJobHandlers } from './modules/jobs/handlers.js';
import { startSchedulerLoop } from './modules/jobs/scheduler-loop.js';
import { appSchedules } from './modules/jobs/schedules.js';
import { startWorker } from './modules/jobs/worker.js';
import { createLogMailer, createSmtpMailer } from './modules/mail/mailer.js';
import { systemClock } from './lib/clock.js';
import { prepareDatabase } from './startup.js';

const WORKER_INTERVAL_MS = 2000;
const SCHEDULER_INTERVAL_MS = 60_000;
const SHUTDOWN_GRACE_MS = 10_000;

// Pas d'await de premier niveau : LiteSpeed (lsnode.js) charge ce fichier via require().
async function main(): Promise<void> {
  // Développement uniquement : .env du répertoire courant (en production, variables du panneau Hostinger).
  if (process.env.NODE_ENV !== 'production' && existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const config = loadConfig(process.env);
  for (const warning of configWarnings(config)) console.warn(warning);
  const logger = {
    info: (obj: object, msg: string) => console.info(msg, obj),
    warn: (obj: object, msg: string) => console.warn(msg, obj),
    error: (obj: object, msg: string) => console.error(msg, obj),
  };

  const { db, close: closeDb } = createDb(config.databaseUrl);
  const production = config.nodeEnv === 'production';
  // Les échecs d'envoi (invitation, réinitialisation, alertes, récapitulatifs) sont journalisés par le décorateur.
  const mailer = reportingMailer(config.smtp ? createSmtpMailer(config.smtp) : createLogMailer(logger, production), {
    db,
    clock: systemClock,
  });
  try {
    await prepareDatabase({
      db,
      config,
      clock: systemClock,
      logger: { info: (m) => console.info(m), warn: (m) => console.warn(m), error: (m) => console.error(m) },
    });
  } catch (err) {
    await closeDb().catch(() => undefined);
    throw err;
  }

  const handlers = createJobHandlers({ db, mailer, config, clock: systemClock, logger });
  // Alertes immédiates des erreurs graves : l'écouteur crée une tâche `error_alert` (il ne lève jamais).
  setGraveListener(createGraveListener({ db, clock: systemClock }));
  const schedules = appSchedules(); // entrées validées ici : une erreur de planification empêche le démarrage

  let worker: ReturnType<typeof startWorker> | undefined;
  const app = await buildApp({
    config,
    clock: systemClock,
    db,
    mailer,
    schedules,
    workerStatus: () => worker?.status() ?? 'stopped',
  });
  await app.listen({ port: config.port, host: '0.0.0.0' });

  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`.slice(0, 64);
  // Annulé à l'arrêt : la tâche en cours s'interrompt à sa prochaine étape (remise en file sans tentative consommée).
  const stopping = new AbortController();
  const runningWorker = startWorker({ db, clock: systemClock, workerId, signal: stopping.signal }, handlers, {
    intervalMs: WORKER_INTERVAL_MS,
  });
  worker = runningWorker;
  // Reprise des tâches abandonnées et planification : un passage immédiat puis toutes les 60 s.
  const scheduler = startSchedulerLoop({ db, schedules, clock: systemClock, logger }, { intervalMs: SCHEDULER_INTERVAL_MS });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopping.abort();
    void (async () => {
      try {
        // Une tâche bloquée ne doit pas empêcher l'arrêt : attente bornée.
        await Promise.race([
          Promise.all([scheduler.stop(), runningWorker.stop()]),
          new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
        ]);
        await app.close();
        await closeDb();
        process.exit(0);
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    })();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
