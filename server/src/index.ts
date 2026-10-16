import { existsSync } from 'node:fs';
import { buildApp } from './app.js';
import { configWarnings, loadConfig } from './config/config.js';
import { systemClock } from './lib/clock.js';

// Pas d'await de premier niveau : LiteSpeed (lsnode.js) charge ce fichier via require().
async function main(): Promise<void> {
  // Développement uniquement : .env du répertoire courant (en production, variables du panneau Hostinger).
  if (process.env.NODE_ENV !== 'production' && existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const config = loadConfig(process.env);
  for (const warning of configWarnings(config)) console.warn(warning);

  const app = await buildApp({ config, clock: systemClock });
  await app.listen({ port: config.port, host: '0.0.0.0' });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void app
      .close()
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
