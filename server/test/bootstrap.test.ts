import { count, eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { createDb, type Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { auditLog, users } from '../src/db/schema/core.js';
import { verifyPassword } from '../src/lib/crypto.js';
import { ensureBootstrapAdmin } from '../src/modules/auth/bootstrap.js';
import { createUsersRepo } from '../src/modules/users/users.repo.js';
import { prepareDatabase } from '../src/startup.js';
import { seedUser, testConfig } from './helpers/test-app.js';
import { createEmptyTestDb } from './helpers/test-db.js';

const PASSWORD = 'p'.repeat(12);
const EMAIL = 'laurent@eksplodo.fr';
const config = { ...testConfig(), bootstrapAdmin: { email: EMAIL, password: PASSWORD } };
const clock = () => new Date('2026-01-15T10:00:00.000Z');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
}, 60_000);

async function freshDb(migrate = true): Promise<{ db: Db; url: string }> {
  const empty = await createEmptyTestDb();
  cleanups.push(empty.destroy);
  const { db, close } = createDb(empty.url);
  cleanups.push(close);
  if (migrate) await runMigrations(db);
  return { db, url: empty.url };
}

async function countAdmins(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users).where(eq(users.role, 'admin'));
  return Number(row?.n ?? 0);
}

describe('premier Admin', () => {
  test('crée l’Admin actif depuis la config', async () => {
    const { db } = await freshDb();
    const r = await ensureBootstrapAdmin({ db, config, clock });
    expect(r).toBe('created');
    const admin = await createUsersRepo(db).findByEmail(EMAIL);
    expect(admin).toMatchObject({ role: 'admin', status: 'active', name: 'Admin' });
    expect(await verifyPassword(admin!.passwordHash!, PASSWORD)).toBe(true);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'bootstrap_admin'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ targetType: 'user', targetId: admin!.id, actorUserId: null });
    expect(JSON.stringify(audits[0])).not.toContain(PASSWORD);
  });

  test('ne fait rien s’il existe déjà un Admin, même désactivé', async () => {
    const { db } = await freshDb();
    await seedUser(db, { email: 'autre@eksplodo.fr', role: 'admin', status: 'disabled' });
    expect(await ensureBootstrapAdmin({ db, config, clock })).toBe('skipped');
    expect(await countAdmins(db)).toBe(1);
    expect(await createUsersRepo(db).findByEmail(EMAIL)).toBeNull();
  });

  test('ne fait rien sans configuration', async () => {
    const { db } = await freshDb();
    expect(await ensureBootstrapAdmin({ db, config: testConfig(), clock })).toBe('skipped');
    expect(await countAdmins(db)).toBe(0);
  });

  test('e-mail déjà pris par un compte non Admin : aucun Admin, pas d’erreur', async () => {
    const { db } = await freshDb();
    await seedUser(db, { email: EMAIL, role: 'user' });
    expect(await ensureBootstrapAdmin({ db, config, clock })).toBe('skipped');
    expect(await countAdmins(db)).toBe(0);
  });

  test('deux appels simultanés → un seul Admin', async () => {
    const { db } = await freshDb();
    const results = await Promise.all([
      ensureBootstrapAdmin({ db, config, clock }),
      ensureBootstrapAdmin({ db, config, clock }),
    ]);
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(await countAdmins(db)).toBe(1);
  });

  test('deux démarrages simultanés (prepareDatabase) → un seul Admin', async () => {
    const { url } = await freshDb(false);
    const a = createDb(url);
    const b = createDb(url);
    cleanups.push(a.close, b.close);
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    await Promise.all([
      prepareDatabase({ db: a.db, config, clock, logger }),
      prepareDatabase({ db: b.db, config, clock, logger }),
    ]);
    expect(await countAdmins(a.db)).toBe(1);
  }, 60_000);

  test('le mot de passe n’apparaît dans aucun journal', async () => {
    const { db } = await freshDb();
    const logs: string[] = [];
    const log = (m: string) => void logs.push(m);
    const logger = { info: log, warn: log, error: log };
    await ensureBootstrapAdmin({ db, config, clock, logger });
    await seedUser(db, { email: 'x@eksplodo.fr', role: 'user' });
    await ensureBootstrapAdmin({ db, config, clock, logger });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(PASSWORD);
  });
});
