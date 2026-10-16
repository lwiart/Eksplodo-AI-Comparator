import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { poolOf, type Db } from '../src/db/client.js';
import { users } from '../src/db/schema/core.js';
import { createTestDb } from './helpers/test-db.js';

let db: Db;
let destroy: () => Promise<void>;

beforeAll(async () => {
  ({ db, destroy } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await destroy();
});

test('migrations appliquées sur une base vierge', async () => {
  for (const table of ['users', 'invitations', 'sessions', 'settings', 'audit_log', 'jobs', 'error_events']) {
    const [rows] = await poolOf(db).query(`SELECT COUNT(*) AS n FROM \`${table}\``);
    expect(Number((rows as { n: number }[])[0]!.n)).toBe(0);
  }
});

test('e-mail unique sans tenir compte de la casse', async () => {
  const insert = (email: string) => db.insert(users).values({ id: randomUUID(), email, name: 'L', role: 'admin' });
  await insert('laurent@eksplodo.fr');
  // Drizzle enveloppe l'erreur mysql2 : le message « Duplicate entry » est dans `cause`.
  const err = await insert('LAURENT@eksplodo.fr').then(
    () => null,
    (e: unknown) => e as Error & { cause?: Error },
  );
  expect(err).not.toBeNull();
  expect(err!.cause?.message ?? err!.message).toMatch(/Duplicate/);
});

test('statut par défaut : invited', async () => {
  const id = randomUUID();
  await db.insert(users).values({ id, email: 'a@eksplodo.fr', name: 'A', role: 'user' });
  const [rows] = await poolOf(db).query('SELECT status FROM users WHERE id = ?', [id]);
  expect((rows as { status: string }[])[0]!.status).toBe('invited');
});

test('aucune colonne org_id', async () => {
  const [rows] = await poolOf(db).query(
    "SELECT TABLE_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'org_id'",
  );
  expect(rows).toEqual([]);
});
