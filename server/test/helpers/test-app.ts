import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config/config.js';
import type { Db } from '../../src/db/client.js';
import { providers, models } from '../../src/db/schema/catalog.js';
import { hashPassword } from '../../src/lib/crypto.js';
import { createProviderRegistry, sealApiKey, type Registry } from '../../src/modules/providers/registry.js';
import { randomUUID } from 'node:crypto';
import type { Role } from '../../src/modules/auth/actor.js';
import type { ScheduleEntry } from '../../src/modules/jobs/scheduler.js';
import { createFakeMailer } from '../../src/modules/mail/mailer.js';
import { createUsersRepo, type UserRow } from '../../src/modules/users/users.repo.js';
import { createTestClock, type TestClock } from './test-clock.js';
import { createTestDb } from './test-db.js';

// Tests qui montent l'application (base de test, hachages argon2 de `seedUser`) : bien au-delà des 5 s par défaut
// quand toute la suite tourne en parallèle. S'applique à chaque fichier qui importe ce module.
vi.setConfig({ testTimeout: 20_000 });

export function testConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    appBaseUrl: 'http://localhost:3000',
    databaseUrl: 'mysql://u:p@127.0.0.1:3307/x',
    dataDir: '/tmp/aic',
    encryptionKey: Buffer.alloc(32, 7),
    cronSecret: 'x'.repeat(32),
    smtp: null,
    bootstrapAdmin: null,
    fakeLlm: false,
    fakeLlmIgnored: false,
  };
}

/** Registre des fournisseurs de test (clé maîtresse de `testConfig`). */
export function testRegistry(opts: { fakeLlm?: boolean; fetch?: typeof fetch } = {}): Registry {
  const c = testConfig();
  return createProviderRegistry({
    encryptionKey: c.encryptionKey,
    fakeLlm: opts.fakeLlm ?? false,
    appBaseUrl: c.appBaseUrl,
    fetch: opts.fetch,
  });
}

export type TestApp = {
  app: FastifyInstance;
  db: Db;
  clock: TestClock;
  mailer: ReturnType<typeof createFakeMailer>;
  destroy(): Promise<void>;
};

/** L'application renvoyée n'est pas encore `ready()` : un test peut y ajouter des routes avant le premier `inject`. */
export async function buildTestApp(opts: { now?: Date; schedules?: ScheduleEntry[]; fakeLlm?: boolean; fetch?: typeof fetch; dataDir?: string } = {}): Promise<TestApp> {
  const testDb = await createTestDb();
  const clock = createTestClock(opts.now ?? new Date('2026-01-15T10:00:00.000Z'));
  const mailer = createFakeMailer();
  try {
    const app = await buildApp({
      config: { ...testConfig(), ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }) },
      clock: () => clock.now(),
      db: testDb.db,
      mailer,
      schedules: opts.schedules ?? [],
      registry: testRegistry({ fakeLlm: opts.fakeLlm, fetch: opts.fetch }),
    });
    return {
      app,
      db: testDb.db,
      clock,
      mailer,
      async destroy() {
        try {
          await app.close();
        } finally {
          await testDb.destroy();
        }
      },
    };
  } catch (err) {
    await testDb.destroy();
    throw err;
  }
}

export async function seedUser(
  db: Db,
  input: {
    email: string;
    role: Role;
    status?: 'active' | 'invited' | 'disabled';
    password?: string;
    name?: string;
  },
): Promise<UserRow> {
  return createUsersRepo(db).insert({
    email: input.email,
    name: input.name ?? 'Utilisateur test',
    role: input.role,
    status: input.status ?? 'active',
    passwordHash: await hashPassword(input.password ?? 'motdepasse-solide'),
  });
}

function cookiesOf(res: { cookies: { name: string; value: string }[] }): Record<string, string> {
  return Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
}

/** Se connecte (obtient d'abord le cookie CSRF) ; `cookie` est la valeur complète de l'en-tête Cookie. */
export async function loginAs(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<{ cookie: string; csrf: string }> {
  const init = await app.inject({ method: 'GET', url: '/api/auth/me' });
  const csrf = cookiesOf(init).aic_csrf;
  if (!csrf) throw new Error('cookie aic_csrf absent');
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { cookie: `aic_csrf=${csrf}`, 'x-csrf-token': csrf },
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`connexion refusée (${res.statusCode}) : ${res.body}`);
  const session = cookiesOf(res).aic_session;
  if (!session) throw new Error('cookie aic_session absent');
  return { cookie: `aic_session=${session}; aic_csrf=${csrf}`, csrf };
}

/** En-têtes d'une requête anonyme munie d'un jeton CSRF valide (cookie + en-tête). */
export async function csrfHeaders(app: FastifyInstance): Promise<{ cookie: string; 'x-csrf-token': string }> {
  const init = await app.inject({ method: 'GET', url: '/api/auth/me' });
  const csrf = cookiesOf(init).aic_csrf;
  if (!csrf) throw new Error('cookie aic_csrf absent');
  return { cookie: `aic_csrf=${csrf}`, 'x-csrf-token': csrf };
}

type ProviderRow = typeof providers.$inferSelect;
type ModelRow = typeof models.$inferSelect;

/** Insère un fournisseur ; `apiKey` est chiffrée avec la clé maîtresse de test (ou `encryptionKey`). */
export async function seedProvider(
  db: Db,
  overrides: Partial<ProviderRow> & { apiKey?: string; encryptionKey?: Buffer } = {},
): Promise<ProviderRow> {
  const { apiKey, encryptionKey, ...rest } = overrides;
  const sealed = apiKey === undefined ? {} : sealApiKey(apiKey, encryptionKey ?? testConfig().encryptionKey);
  const id = rest.id ?? randomUUID();
  await db.insert(providers).values({
    id,
    name: `Fournisseur ${id.slice(0, 8)}`,
    type: 'openai_compatible',
    baseUrl: 'https://api.example.test/v1',
    ...rest,
    ...sealed,
  });
  const [row] = await db.select().from(providers).where(eq(providers.id, id));
  return row!;
}

export async function seedModel(db: Db, overrides: Partial<ModelRow> & { providerId: string }): Promise<ModelRow> {
  const id = overrides.id ?? randomUUID();
  await db.insert(models).values({
    id,
    apiModelId: `modele-${id.slice(0, 8)}`,
    displayName: 'Modèle test',
    color: '#4f8ef7',
    ...overrides,
  });
  const [row] = await db.select().from(models).where(eq(models.id, id));
  return row!;
}
