import { expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/config.js';
import { createDb } from '../src/db/client.js';
import { NotFoundError } from '../src/errors.js';

const config = loadConfig({
  NODE_ENV: 'test',
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'mysql://u:p@127.0.0.1:3307/x',
  DATA_DIR: '/tmp/aic',
  CRON_SECRET: 'x'.repeat(32),
});

// Pool paresseux : aucune connexion tant qu'aucune requête n'atteint la base.
const { db } = createDb(config.databaseUrl);

async function newApp() {
  return buildApp({ config, clock: () => new Date(), db });
}

test('AppError → format d’erreur unique', async () => {
  const app = await newApp();
  app.get('/boom', async () => {
    throw new NotFoundError('Introuvable');
  });
  const res = await app.inject({ method: 'GET', url: '/boom' });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Introuvable' } });
  await app.close();
});

test('erreur inattendue → 500 sans fuite du message', async () => {
  const app = await newApp();
  app.get('/crash', async () => {
    throw new Error('secret interne');
  });
  const res = await app.inject({ method: 'GET', url: '/crash' });
  expect(res.statusCode).toBe(500);
  expect(res.json().error.code).toBe('internal');
  expect(res.body).not.toContain('secret interne');
  await app.close();
});

test('route inconnue → 404 au format unique', async () => {
  const app = await newApp();
  const res = await app.inject({ method: 'GET', url: '/nulle-part' });
  expect(res.statusCode).toBe(404);
  expect(res.json().error.code).toBe('not_found');
  await app.close();
});

test('en-têtes : CSP sans polices externes', async () => {
  const app = await newApp();
  const res = await app.inject({ method: 'GET', url: '/nulle-part' });
  const csp = String(res.headers['content-security-policy']);
  expect(csp).toContain("font-src 'self'");
  expect(csp).toContain("img-src 'self' data: blob:");
  expect(csp).not.toContain('fonts.googleapis.com');
  expect(csp).not.toContain('fonts.gstatic.com');
  await app.close();
});
