import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import { createDb, poolOf } from '../src/db/client.js';
import { providers, models } from '../src/db/schema/catalog.js';
import { PRESET_PROVIDERS, seedProviders } from '../src/modules/catalog/seed.js';
import { sealApiKey } from '../src/modules/providers/registry.js';
import { prepareDatabase } from '../src/startup.js';
import { createEmptyTestDb, createTestDb } from './helpers/test-db.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
}, 60_000);

const now = new Date('2026-10-17T10:00:00.000Z');
const encryptionKey = Buffer.alloc(32, 1);

async function testDb() {
  const t = await createTestDb();
  cleanups.push(t.destroy);
  return t.db;
}

async function countProviders(db: Awaited<ReturnType<typeof testDb>>) {
  const [row] = await db.select({ n: count() }).from(providers);
  return Number(row!.n);
}

describe('schéma du catalogue', () => {
  test('migration : tables providers, models, openrouter_catalog', async () => {
    const db = await testDb();
    for (const table of ['providers', 'models', 'openrouter_catalog']) {
      const [rows] = await poolOf(db).query(`SELECT COUNT(*) AS n FROM \`${table}\``);
      expect(Number((rows as { n: number }[])[0]!.n)).toBe(0);
    }
  });

  test('premier démarrage : huit fournisseurs préconfigurés sans clé, une seule fois', async () => {
    const db = await testDb();
    expect(PRESET_PROVIDERS).toHaveLength(8);
    expect(await seedProviders(db, now)).toBe('seeded');
    expect(await countProviders(db)).toBe(8);
    const rows = await db.select().from(providers);
    expect(rows.every((p) => p.apiKeyEncrypted === null && p.apiKeyLast4 === null)).toBe(true);
    expect(rows.every((p) => p.maxConcurrency === 2 && p.enabled)).toBe(true);
    await db.delete(providers).where(eq(providers.name, 'DeepSeek'));
    expect(await seedProviders(db, now)).toBe('skipped');
    expect(await countProviders(db)).toBe(7);
  });

  test('un fournisseur de même nom n’est pas écrasé', async () => {
    const db = await testDb();
    await db.insert(providers).values({ id: randomUUID(), name: 'OpenAI', type: 'openai_compatible', baseUrl: 'https://proxy.example/v1' });
    expect(await seedProviders(db, now)).toBe('seeded');
    expect(await countProviders(db)).toBe(8);
    const [openai] = await db.select().from(providers).where(eq(providers.name, 'OpenAI'));
    expect(openai!.baseUrl).toBe('https://proxy.example/v1');
  });

  test('deux démarrages simultanés → huit fournisseurs, pas seize', async () => {
    const empty = await createEmptyTestDb();
    cleanups.push(empty.destroy);
    const a = createDb(empty.url);
    const b = createDb(empty.url);
    cleanups.push(a.close, b.close);
    const noop = () => undefined;
    const config = loadConfig({
      NODE_ENV: 'test',
      APP_BASE_URL: 'http://localhost:3000',
      DATABASE_URL: empty.url,
      DATA_DIR: '/tmp/aic',
      CRON_SECRET: 'x'.repeat(32),
      APP_ENCRYPTION_KEY: encryptionKey.toString('base64'),
    });
    const mk = (db: typeof a.db) => ({ db, config, clock: () => now, logger: { info: noop, warn: noop, error: noop } });
    await Promise.all([prepareDatabase(mk(a.db)), prepareDatabase(mk(b.db))]);
    expect(await countProviders(a.db)).toBe(8);
  }, 60_000);

  test('un modèle est unique par fournisseur ; prix lus en nombres', async () => {
    const db = await testDb();
    const providerId = randomUUID();
    await db.insert(providers).values({ id: providerId, name: 'Test', type: 'openai_compatible', baseUrl: 'https://x.example/v1' });
    const row = { providerId, apiModelId: 'm-1', displayName: 'M1', color: '#112233', inputPricePerM: 0.1, outputPricePerM: 0.5 };
    await db.insert(models).values({ id: randomUUID(), ...row });
    const [back] = await db.select().from(models);
    expect(back!.inputPricePerM).toBe(0.1);
    expect(back!.outputPricePerM).toBe(0.5);
    expect(back!.priceSource).toBe('manual');
    expect(back!.supportsVision).toBe(false);
    // Drizzle enveloppe l'erreur MariaDB : le détail « Duplicate entry » est dans `cause`.
    const dup = await db.insert(models).values({ id: randomUUID(), ...row }).then(() => null, (e: unknown) => e);
    expect(String((dup as { cause?: Error }).cause?.message)).toMatch(/Duplicate/);
  });

  test('aucune colonne de clé en clair (api_key, api_key_env)', async () => {
    const db = await testDb();
    const [rows] = await poolOf(db).query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN ('api_key', 'api_key_env')",
    );
    expect(rows).toEqual([]);
  });

  test('ligne brute d’un fournisseur muni d’une clé : jamais la clé en clair', async () => {
    const db = await testDb();
    const id = randomUUID();
    const sealed = sealApiKey('sk-test-0123456789abcd', encryptionKey, { id, baseUrl: 'https://a.example' });
    await db.insert(providers).values({ id, name: 'Clé', type: 'anthropic', baseUrl: 'https://a.example', ...sealed });
    const [rows] = await poolOf(db).query('SELECT * FROM providers WHERE name = ?', ['Clé']);
    const json = JSON.stringify(rows);
    expect(json).not.toContain('sk-test');
    expect(json.replaceAll('abcd', '')).not.toContain('0123456789');
    expect(json).toContain('abcd');
  });
});
