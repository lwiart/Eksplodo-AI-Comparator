import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { createDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const ROOT_URL = 'mysql://root:test@127.0.0.1:3307';

async function connectRoot(): Promise<mysql.Connection> {
  let lastErr: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      return await mysql.createConnection(ROOT_URL);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Base de test injoignable (docker compose up -d db) : ${String(lastErr)}`);
}

/** Base de test vierge (aucune migration) : seule l'URL est fournie ; à détruire après usage. */
export async function createEmptyTestDb(): Promise<{ url: string; destroy(): Promise<void> }> {
  const name = `test_${randomBytes(6).toString('hex')}`;
  const root = await connectRoot();
  try {
    await root.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch (err) {
    await root.end();
    throw err;
  }
  return {
    url: `${ROOT_URL}/${name}`,
    async destroy() {
      try {
        await root.query(`DROP DATABASE IF EXISTS \`${name}\``);
      } finally {
        await root.end();
      }
    },
  };
}

export async function createTestDb(): Promise<{ db: Db; url: string; destroy(): Promise<void> }> {
  const name = `test_${randomBytes(6).toString('hex')}`;
  const root = await connectRoot();
  try {
    await root.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } catch (err) {
    await root.end();
    throw err;
  }
  const url = `${ROOT_URL}/${name}`;
  const { db, close } = createDb(url);
  try {
    await runMigrations(db);
  } catch (err) {
    await close();
    await root.query(`DROP DATABASE \`${name}\``);
    await root.end();
    throw err;
  }
  return {
    db,
    url,
    async destroy() {
      try {
        await close();
      } finally {
        try {
          await root.query(`DROP DATABASE IF EXISTS \`${name}\``);
        } finally {
          await root.end();
        }
      }
    },
  };
}
