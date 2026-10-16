import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config/config.js';
import { createDb } from '../src/db/client.js';
import { createFakeMailer } from '../src/modules/mail/mailer.js';
import { testConfig } from './helpers/test-app.js';

// Base injoignable, jamais sollicitée par ces routes.
const lazy = createDb('mysql://u:p@127.0.0.1:1/x');
let webRoot: string;

const INDEX = '<!doctype html><html><body><div id="root"></div></body></html>';

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), 'aic-web-'));
  writeFileSync(join(webRoot, 'index.html'), INDEX);
  mkdirSync(join(webRoot, 'assets'));
  writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log(1)');
});
afterAll(async () => {
  rmSync(webRoot, { recursive: true, force: true });
  await lazy.close();
});

function newApp(opts: { webRoot?: string; config?: Partial<AppConfig> } = {}): Promise<FastifyInstance> {
  return buildApp({
    config: { ...testConfig(), ...opts.config },
    clock: () => new Date(),
    db: lazy.db,
    mailer: createFakeMailer(),
    schedules: [],
    logStream: { write: () => undefined }, // journal muet : sortie de test propre
    ...(opts.webRoot !== undefined ? { webRoot: opts.webRoot } : {}),
  });
}

describe('interface statique', () => {
  test('repli SPA : /connexion renvoie index.html, /api/inconnu renvoie 404 JSON', async () => {
    const app = await newApp({ webRoot });
    const page = await app.inject({ method: 'GET', url: '/connexion' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toBe(INDEX);

    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toBe(INDEX);

    const deep = await app.inject({ method: 'GET', url: '/admin/utilisateurs/123?x=1' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toBe(INDEX);

    const api = await app.inject({ method: 'GET', url: '/api/inconnu' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: { code: 'not_found', message: 'Ressource introuvable' } });

    const internal = await app.inject({ method: 'GET', url: '/internal/inconnu' });
    expect(internal.statusCode).toBe(404);
    expect(internal.json()).toMatchObject({ error: { code: 'not_found' } });
    const share = await app.inject({ method: 'GET', url: '/share/abc' });
    expect(share.statusCode).toBe(404);
    expect(share.json()).toMatchObject({ error: { code: 'not_found' } });
    await app.close();
  });

  test('sert les fichiers du build ; un fichier absent → 404 JSON (pas index.html)', async () => {
    const app = await newApp({ webRoot });
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log(1)');

    const missing = await app.inject({ method: 'GET', url: '/assets/absent.js' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'not_found' } });
    await app.close();
  });

  test('POST hors API → 404 JSON (pas de repli SPA)', async () => {
    const app = await newApp({ webRoot });
    const res = await app.inject({
      method: 'POST',
      url: '/connexion',
      headers: { cookie: 'aic_csrf=t', 'x-csrf-token': 't' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    await app.close();
  });

  test('dossier du build absent : aucune route statique, pas de plantage', async () => {
    const app = await newApp({ webRoot: join(webRoot, 'nexiste-pas') });
    const res = await app.inject({ method: 'GET', url: '/connexion' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    await app.close();
  });

  test('en-têtes de sécurité présents', async () => {
    const app = await newApp({ webRoot });
    const res = await app.inject({ method: 'GET', url: '/connexion' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toMatch(/https?:\/\/(fonts\.|[^ ;]*googleapis)/);
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeUndefined();

    const api = await app.inject({ method: 'GET', url: '/api/inconnu' });
    expect(api.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  test('HSTS uniquement en production', async () => {
    const app = await newApp({ webRoot, config: { nodeEnv: 'production' } });
    const res = await app.inject({ method: 'GET', url: '/connexion' });
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    await app.close();
  });
});
