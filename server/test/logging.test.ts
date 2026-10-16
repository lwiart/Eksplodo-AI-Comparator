import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFakeMailer } from '../src/modules/mail/mailer.js';
import { loadConfig } from '../src/config/config.js';
import { createDb } from '../src/db/client.js';
import { redactUrl } from '../src/plugins/logging.js';

const config = loadConfig({
  NODE_ENV: 'production',
  APP_BASE_URL: 'https://example.test',
  DATABASE_URL: 'mysql://u:p@127.0.0.1:3307/x',
  DATA_DIR: '/tmp/aic',
  CRON_SECRET: 'x'.repeat(32),
});

// Pool paresseux : aucune connexion tant qu'aucune requête n'atteint la base.
const { db } = createDb(config.databaseUrl);

describe('journal des requêtes', () => {
  test('redactUrl masque les jetons de la chaîne de requête', () => {
    expect(redactUrl('/invitation?token=abc123')).toBe('/invitation?token=[redacted]');
    expect(redactUrl('/reinitialisation?x=1&token=abc&y=2')).toBe('/reinitialisation?x=1&token=[redacted]&y=2');
    expect(redactUrl('/a?resetToken=zz#f')).toBe('/a?resetToken=[redacted]#f');
    expect(redactUrl('/connexion')).toBe('/connexion');
  });

  test('un jeton dans l’URL n’apparaît jamais dans les journaux', async () => {
    const lines: string[] = [];
    const app = await buildApp({
      config,
      clock: () => new Date(),
      mailer: createFakeMailer(),
      db,
      schedules: [],
      logStream: { write: (line: string) => void lines.push(line) },
    });
    await app.inject({ method: 'GET', url: '/invitation?token=jeton-secret-abc' });
    await app.inject({ method: 'GET', url: '/reinitialisation?token=jeton-secret-def&x=1' });
    await app.close();
    const out = lines.join('');
    expect(out).toContain('/invitation?token=[redacted]');
    expect(out).not.toContain('jeton-secret');
  });

  test('erreur inattendue : seul le nom de l’erreur est journalisé, jamais son message', async () => {
    const lines: string[] = [];
    const app = await buildApp({
      config,
      clock: () => new Date(),
      mailer: createFakeMailer(),
      db,
      schedules: [],
      logStream: { write: (line: string) => void lines.push(line) },
    });
    app.get('/crash', async () => {
      throw new TypeError('texte-confidentiel');
    });
    expect((await app.inject({ method: 'GET', url: '/crash' })).statusCode).toBe(500);
    await app.close();
    const out = lines.join('');
    expect(out).not.toContain('texte-confidentiel');
    const logged = lines
      .map((l) => JSON.parse(l) as { msg?: string; err?: Record<string, unknown> })
      .filter((l) => l.msg === 'erreur inattendue');
    expect(logged).toHaveLength(1);
    expect(logged[0]!.err).toEqual({ name: 'TypeError' });
  });
});
