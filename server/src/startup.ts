import type { AppConfig } from './config/config.js';
import { poolOf, type Db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import type { Clock } from './lib/clock.js';
import { ensureBootstrapAdmin } from './modules/auth/bootstrap.js';
import { upgradeLegacyKeys } from './modules/catalog/key-upgrade.js';
import { seedProviders } from './modules/catalog/seed.js';

const DEFAULT_LOCK_TIMEOUT_SEC = 120;

export type StartupLogger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

/**
 * Exécute `fn` en tenant le verrou nommé MariaDB `name`, pris sur une connexion dédiée : plusieurs processus
 * démarrant en même temps (un par nom d'hôte chez Hostinger) se sérialisent. Le verrou est propre à la base
 * (un serveur MariaDB mutualisé héberge d'autres bases) ; nom limité à 64 caractères. Échec explicite si le verrou
 * n'est pas obtenu dans le délai ; libération systématique.
 */
export async function withStartupLock<T>(
  db: Db,
  name: string,
  fn: () => Promise<T>,
  timeoutSec: number = DEFAULT_LOCK_TIMEOUT_SEC,
): Promise<T> {
  const conn = await poolOf(db).getConnection();
  let reusable = true;
  try {
    const [nameRows] = await conn.query("SELECT LEFT(CONCAT('aic:', ?, ':', DATABASE()), 64) AS n", [name]);
    const lockName = (nameRows as { n: string }[])[0]!.n;
    const [rows] = await conn.query('SELECT GET_LOCK(?, ?) AS l', [lockName, timeoutSec]);
    const got = (rows as { l: number | string | null }[])[0]?.l;
    if (Number(got) !== 1) {
      throw new Error(
        `Démarrage impossible : verrou de démarrage MariaDB non obtenu en ${timeoutSec} s (un autre processus migre la base ?)`,
      );
    }
    try {
      return await fn();
    } finally {
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
      } catch {
        reusable = false; // connexion perdue : MariaDB libère le verrou avec la session
      }
    }
  } finally {
    if (reusable) conn.release();
    else conn.destroy();
  }
}

/** Migrations, amorçage du premier Admin et conversion des anciennes clés, sérialisés entre processus par le même verrou. */
export async function prepareDatabase(deps: {
  db: Db;
  config: AppConfig;
  clock: Clock;
  logger?: StartupLogger;
  lockTimeoutSec?: number;
}): Promise<void> {
  await withStartupLock(
    deps.db,
    'startup',
    async () => {
      await runMigrations(deps.db);
      await ensureBootstrapAdmin({
        db: deps.db,
        config: deps.config,
        clock: deps.clock,
        ...(deps.logger ? { logger: deps.logger } : {}),
      });
      await seedProviders(deps.db, deps.clock());
      const keys = await upgradeLegacyKeys(deps.db, deps.config.encryptionKey);
      if (keys.upgraded > 0) deps.logger?.info(`Clés des fournisseurs converties au format lié au fournisseur : ${keys.upgraded}`);
      if (keys.unreadable > 0) {
        deps.logger?.warn(`Clés des fournisseurs illisibles, non converties (à ressaisir) : ${keys.unreadable}`);
      }
    },
    deps.lockTimeoutSec,
  );
}
