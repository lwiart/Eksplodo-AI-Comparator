import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import { createDb } from '../src/db/client.js';
import { createFakeMailer } from '../src/modules/mail/mailer.js';
import { seedProvider, testRegistry } from './helpers/test-app.js';
import { seedProviders } from '../src/modules/catalog/seed.js';
import { providers } from '../src/db/schema/catalog.js';
import { createTestDb } from './helpers/test-db.js';

const config = loadConfig({
  NODE_ENV: 'test',
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'mysql://u:p@127.0.0.1:3307/x',
  DATA_DIR: '/tmp/aic',
  CRON_SECRET: 'x'.repeat(32),
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
});

let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  testDb = await createTestDb();
}, 60_000);
beforeEach(async () => {
  await testDb.db.delete(providers); // tests indépendants de l'ordre
});
afterAll(async () => {
  await testDb.destroy();
});

test('GET /health : base joignable', async () => {
  const app = await buildApp({ config, clock: () => new Date(), mailer: createFakeMailer(), db: testDb.db, schedules: [], registry: testRegistry() });
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok', db: 'ok', worker: 'stopped', providers: { configured: 0 } });
  await app.close();
});

test('GET /health : nombre de fournisseurs configurés seulement', async () => {
  await seedProviders(testDb.db, new Date()); // huit préconfigurés sans clé
  await seedProvider(testDb.db, { name: 'Avec clé', apiKey: 'sk-test-0123456789abcd' });
  await seedProvider(testDb.db, { name: 'Désactivé', apiKey: 'sk-test-0123456789abcd', enabled: false });
  const app = await buildApp({ config, clock: () => new Date(), mailer: createFakeMailer(), db: testDb.db, schedules: [], registry: testRegistry() });
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.json()).toEqual({ status: 'ok', db: 'ok', worker: 'stopped', providers: { configured: 1 } });
  await app.close();
});

test('GET /health : état du worker transmis', async () => {
  const app = await buildApp({ config, clock: () => new Date(), mailer: createFakeMailer(), db: testDb.db, schedules: [], registry: testRegistry(), workerStatus: () => 'running' });
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.json()).toMatchObject({ worker: 'running' });
  await app.close();
});

test('GET /health : base injoignable → 503', async () => {
  const dead = createDb('mysql://root:test@127.0.0.1:1/x'); // port fermé
  const app = await buildApp({ config, clock: () => new Date(), mailer: createFakeMailer(), db: dead.db, schedules: [], registry: testRegistry() });
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toMatchObject({ status: 'degraded', db: 'down' });
  await app.close();
  await dead.close();
}, 15_000);
