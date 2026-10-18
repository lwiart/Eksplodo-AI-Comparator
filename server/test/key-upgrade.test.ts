import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import { createDb } from '../src/db/client.js';
import { providers } from '../src/db/schema/catalog.js';
import { upgradeLegacyKeys } from '../src/modules/catalog/key-upgrade.js';
import { createProviderRegistry } from '../src/modules/providers/registry.js';
import { prepareDatabase } from '../src/startup.js';
import { createEmptyTestDb, createTestDb } from './helpers/test-db.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
}, 60_000);

const encryptionKey = Buffer.alloc(32, 3);
const now = new Date('2026-10-18T10:00:00.000Z');

/** Chiffré à l'ancien format v1 (sans contexte), tel qu'écrit avant la liaison au fournisseur. */
function legacySeal(plain: string, k: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

async function testDb() {
  const t = await createTestDb();
  cleanups.push(t.destroy);
  return t.db;
}

describe('conversion des clés v1', () => {
  test('v1 lisible → v2 lié au fournisseur ; v1 illisible laissée ; idempotent', async () => {
    const db = await testDb();
    const registry = createProviderRegistry({ encryptionKey, fakeLlm: false, appBaseUrl: 'http://x' });
    const okId = randomUUID();
    const badId = randomUUID();
    const badBlob = legacySeal('sk-autre-cle-0123456789', Buffer.alloc(32, 9));
    await db.insert(providers).values([
      {
        id: okId,
        name: 'Ancien',
        type: 'openai_compatible',
        baseUrl: 'https://api.example.test/v1',
        apiKeyEncrypted: legacySeal('sk-test-0123456789abcd', encryptionKey),
        apiKeyLast4: 'abcd',
      },
      { id: badId, name: 'Illisible', type: 'anthropic', baseUrl: 'https://a.example.test', apiKeyEncrypted: badBlob },
      { id: randomUUID(), name: 'Sans clé', type: 'google', baseUrl: 'https://g.example.test' },
    ]);

    expect(await upgradeLegacyKeys(db, encryptionKey)).toEqual({ upgraded: 1, unreadable: 1 });

    const [ok] = await db.select().from(providers).where(eq(providers.id, okId));
    expect(ok!.apiKeyEncrypted!.startsWith('v2.')).toBe(true);
    expect(registry.keyStatus(ok!)).toMatchObject({ state: 'stored', usable: true });
    expect(registry.keyStatus({ ...ok!, baseUrl: 'https://attaquant.example/v1' })).toMatchObject({ state: 'unreadable' });
    const [bad] = await db.select().from(providers).where(eq(providers.id, badId));
    expect(bad!.apiKeyEncrypted).toBe(badBlob);

    expect(await upgradeLegacyKeys(db, encryptionKey)).toEqual({ upgraded: 0, unreadable: 1 });
  });

  test('prepareDatabase convertit au démarrage', async () => {
    const empty = await createEmptyTestDb();
    cleanups.push(empty.destroy);
    const { db, close } = createDb(empty.url);
    cleanups.push(close);
    const config = loadConfig({
      NODE_ENV: 'test',
      APP_BASE_URL: 'http://localhost:3000',
      DATABASE_URL: empty.url,
      DATA_DIR: '/tmp/aic',
      CRON_SECRET: 'x'.repeat(32),
      APP_ENCRYPTION_KEY: encryptionKey.toString('base64'),
    });
    const infos: string[] = [];
    const logger = { info: (m: string) => infos.push(m), warn: () => undefined, error: () => undefined };
    await prepareDatabase({ db, config, clock: () => now, logger });
    const [openai] = await db.select().from(providers).where(eq(providers.name, 'OpenAI'));
    await db
      .update(providers)
      .set({ apiKeyEncrypted: legacySeal('sk-test-0123456789abcd', encryptionKey) })
      .where(eq(providers.id, openai!.id));

    await prepareDatabase({ db, config, clock: () => now, logger });

    const [after] = await db.select().from(providers).where(eq(providers.id, openai!.id));
    expect(after!.apiKeyEncrypted!.startsWith('v2.')).toBe(true);
    const registry = createProviderRegistry({ encryptionKey, fakeLlm: false, appBaseUrl: 'http://x' });
    expect(registry.keyStatus(after!)).toMatchObject({ state: 'stored', usable: true });
    expect(infos.some((m) => m.includes('converties') && m.endsWith(': 1'))).toBe(true);
  }, 60_000);
});
