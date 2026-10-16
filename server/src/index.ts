import { existsSync } from 'node:fs';
import { buildApp } from './app.js';
import { configWarnings, loadConfig } from './config/config.js';
import { createDb } from './db/client.js';
import { systemClock } from './lib/clock.js';
import { prepareDatabase } from './startup.js';

// Pas d'await de premier niveau : LiteSpeed (lsnode.js) charge ce fichier via require().
async function main(): Promise<void> {
  // Développement uniquement : .env du répertoire courant (en production, variables du panneau Hostinger).
  if (process.env.NODE_ENV !== 'production' && existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const config = loadConfig(process.env);
  for (const warning of configWarnings(config)) console.warn(warning);

  const { db, close: closeDb } = createDb(config.databaseUrl);
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

  // Le worker de tâches (Task 5) fournira l'état réel ; en attendant il est arrêté.
  const app = await buildApp({ config, clock: systemClock, db, workerStatus: () => 'stopped' });
  await app.listen({ port: config.port, host: '0.0.0.0' });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void app
      .close()
      .then(() => closeDb())
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
