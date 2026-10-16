import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import { createFakeMailer } from '../src/modules/mail/mailer.js';
import { createTestDb } from './helpers/test-db.js';

const SECRET = 'x'.repeat(32);
const config = loadConfig({
  NODE_ENV: 'test',
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'mysql://u:p@127.0.0.1:3307/x',
  DATA_DIR: '/tmp/aic',
  CRON_SECRET: SECRET,
});

let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  testDb = await createTestDb();
}, 60_000);
afterAll(async () => {
  await testDb.destroy();
});

async function build() {
  return buildApp({ config, clock: () => new Date(), mailer: createFakeMailer(), db: testDb.db, schedules: [] });
}

test('GET /internal/diag : 401 sans secret ou avec un mauvais secret', async () => {
  const app = await build();
  const none = await app.inject({ method: 'GET', url: '/internal/diag' });
  expect(none.statusCode).toBe(401);
  const wrong = await app.inject({ method: 'GET', url: '/internal/diag', headers: { 'x-cron-secret': 'y'.repeat(32) } });
  expect(wrong.statusCode).toBe(401);
  await app.close();
});

test('GET /internal/diag : 200 avec les informations de diagnostic', async () => {
  const app = await build();
  const res = await app.inject({ method: 'GET', url: '/internal/diag', headers: { 'x-cron-secret': SECRET } });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.nodeVersion).toBe(process.version);
  expect(typeof body.uptimeSeconds).toBe('number');
  expect(typeof body.memory.rss).toBe('number');
  expect(typeof body.mariadbVersion).toBe('string');
  expect(body.mariadbVersion.length).toBeGreaterThan(0);
  await app.close();
});

test('GET /internal/diag?waitSeconds=1 : attend au moins une seconde', async () => {
  const app = await build();
  const start = Date.now();
  const res = await app.inject({ method: 'GET', url: '/internal/diag?waitSeconds=1', headers: { 'x-cron-secret': SECRET } });
  expect(res.statusCode).toBe(200);
  expect(Date.now() - start).toBeGreaterThanOrEqual(990);
  await app.close();
});

test('GET /internal/diag?waitSeconds=121 : 400 (plafond de 120 s)', async () => {
  const app = await build();
  const res = await app.inject({ method: 'GET', url: '/internal/diag?waitSeconds=121', headers: { 'x-cron-secret': SECRET } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe('validation');
  await app.close();
});
