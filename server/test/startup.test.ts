import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import { createDb } from '../src/db/client.js';
import { MIGRATIONS_FOLDER } from '../src/db/migrate.js';
import { prepareDatabase, withStartupLock } from '../src/startup.js';
import { createEmptyTestDb } from './helpers/test-db.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
}, 60_000);

const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop };
const config = loadConfig({
  NODE_ENV: 'test',
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'mysql://u:p@127.0.0.1:3307/x',
  DATA_DIR: '/tmp/aic',
  CRON_SECRET: 'x'.repeat(32),
});
const LOCK_SQL = "SELECT GET_LOCK(LEFT(CONCAT('aic:startup:', DATABASE()), 64), 0) AS l";

async function freshDb() {
  const empty = await createEmptyTestDb();
  cleanups.push(empty.destroy);
  return empty.url;
}

function pool(url: string) {
  const d = createDb(url);
  cleanups.push(d.close);
  return d.db;
}

function deps(db: ReturnType<typeof pool>, lockTimeoutSec?: number) {
  return {
    db,
    config,
    clock: () => new Date('2026-01-15T10:00:00.000Z'),
    logger,
    ...(lockTimeoutSec !== undefined ? { lockTimeoutSec } : {}),
  };
}

describe('démarrage sérialisé (verrou nommé MariaDB)', () => {
  test('deux processus simultanés sur une base vierge : tous deux réussissent, migrations appliquées une fois', async () => {
    const url = await freshDb();
    const a = pool(url);
    const b = pool(url); // deux pools distincts : comme deux processus
    await Promise.all([prepareDatabase(deps(a)), prepareDatabase(deps(b))]);

    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
      entries: unknown[];
    };
    const conn = await mysql.createConnection(url);
    cleanups.push(() => conn.end());
    const [rows] = await conn.query('SELECT COUNT(*) AS n FROM __drizzle_migrations');
    expect(Number((rows as { n: number }[])[0]!.n)).toBe(journal.entries.length);
  }, 60_000);

  test('verrou indisponible dans le délai : le démarrage échoue clairement', async () => {
    const url = await freshDb();
    const holder = await mysql.createConnection(url);
    cleanups.push(() => holder.end());
    const [got] = await holder.query(LOCK_SQL);
    expect(Number((got as { l: number }[])[0]!.l)).toBe(1);

    await expect(prepareDatabase(deps(pool(url), 1))).rejects.toThrow(/verrou de démarrage/);
  }, 30_000);

  test('le verrou est libéré même si la séquence échoue', async () => {
    const url = await freshDb();
    const db = pool(url);
    await expect(withStartupLock(db, 'startup', async () => Promise.reject(new Error('boum')))).rejects.toThrow('boum');
    const other = await mysql.createConnection(url);
    cleanups.push(() => other.end());
    const [got] = await other.query(LOCK_SQL);
    expect(Number((got as { l: number }[])[0]!.l)).toBe(1);
  }, 30_000);
});
