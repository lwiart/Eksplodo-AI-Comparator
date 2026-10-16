import path from 'node:path';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { APP_ROOT } from '../lib/paths.js';
import type { Db } from './client.js';

// Résolu depuis la racine de l'application (emplacement du module, pas le répertoire courant).
export const MIGRATIONS_FOLDER = path.join(APP_ROOT, 'server', 'drizzle');

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
