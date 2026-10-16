import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import { createDb } from '../src/db/client.js';
import { createFakeMailer } from '../src/modules/mail/mailer.js';
import { createTestDb } from './helpers/test-db.js';

const config = loadConfig({
  NODE_ENV: 'test',
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'mysql://u:p@127.0.0.1:3307/x',
  DATA_DIR: '/tmp/aic',
  CRON_SECRET: 'x'.repeat(32),
});

let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  testDb = await createTestDb();
}, 60_000);
afterAll(async () => {
  await testDb.destroy();
});

test('GET /health : base joignable', async () => {
  const app = await buildApp({ config, clock: () => new Date(), mailer: createFakeMailer(), db: testDb.db });
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok', db: 'ok', worker: 'stopped' });
  await app.close();
});

test('GET /health : état du worker transmis', async () => {
  const app = await buildApp({ config, clock: () => new Date(), mailer: createFakeMailer(), db: testDb.db, workerStatus: () => 'running' });
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.json()).toMatchObject({ worker: 'running' });
  await app.close();
});

test('GET /health : base injoignable → 503', async () => {
  const dead = createDb('mysql://root:test@127.0.0.1:1/x'); // port fermé
  const app = await buildApp({ config, clock: () => new Date(), mailer: createFakeMailer(), db: dead.db });
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toMatchObject({ status: 'degraded', db: 'down' });
  await app.close();
  await dead.close();
}, 15_000);
