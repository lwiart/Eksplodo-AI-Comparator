import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { models, providers } from '../src/db/schema/catalog.js';
import { settings } from '../src/db/schema/core.js';
import { suiteTests, suites, testAttachments, tests } from '../src/db/schema/tests.js';
import { SAMPLE_PNG } from '../src/modules/catalog/capabilities.js';
import { resolveAttachmentPath } from '../src/modules/tests/attachments.js';
import { seedModels, seedTests, type SeedFile } from '../src/modules/tests/seed.js';
import { createTestDb } from './helpers/test-db.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
}, 60_000);

const NOW = new Date('2026-10-18T12:00:00.000Z');

/** Jeu de deux tests (dont un avec une image) et d'une suite, dans un dossier temporaire ; renvoie aussi un DATA_DIR vide. */
async function fixture(seed?: SeedFile) {
  const t = await createTestDb();
  const seedDir = await mkdtemp(path.join(tmpdir(), 'aic-seed-'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'aic-data-'));
  cleanups.push(t.destroy, () => rm(seedDir, { recursive: true, force: true }), () => rm(dataDir, { recursive: true, force: true }));
  if (seed !== undefined) {
    await mkdir(path.join(seedDir, 'attachments'));
    await writeFile(path.join(seedDir, 'attachments', '02-1.png'), SAMPLE_PNG);
    await writeFile(path.join(seedDir, 'tests.json'), JSON.stringify(seed));
  }
  return { db: t.db, seedDir, dataDir };
}

const SEED: SeedFile = {
  version: 1,
  tests: [
    {
      name: 'Capitale',
      category: 'Culture',
      tags: ['géographie'],
      userPrompt: 'Capitale de la France ?',
      scoringMethod: 'expected',
      scoringConfig: { mode: 'exact', expected: 'Paris' },
    },
    {
      name: 'Décrire une image',
      category: 'Vision',
      systemPrompt: 'Sois bref.',
      userPrompt: 'Que montre cette image ?',
      temperature: 0.3,
      maxTokens: 400,
      scoringMethod: 'judge',
      scoringConfig: { criteria: 'Couleur juste.' },
      attachments: [{ file: 'attachments/02-1.png', originalName: 'carre.png' }],
    },
  ],
  suites: [{ name: 'Démarrage', description: 'Deux tests', tests: ['Décrire une image', 'Capitale', 'Inconnu'] }],
};

test('première installation : tests, pièce jointe (fichier sous DATA_DIR) et suite dans l’ordre du jeu', async () => {
  const f = await fixture(SEED);
  expect(await seedTests({ db: f.db, dataDir: f.dataDir, now: NOW, seedDir: f.seedDir })).toEqual({ status: 'seeded', tests: 2, suites: 1 });
  const rows = await f.db.select().from(tests).orderBy(asc(tests.name));
  expect(rows.map((r) => [r.name, r.category, r.scoringMethod])).toEqual([
    ['Capitale', 'Culture', 'expected'],
    ['Décrire une image', 'Vision', 'judge'],
  ]);
  // Configuration normalisée comme à la création par l'API (valeurs par défaut ajoutées).
  expect(rows[0]!.scoringConfig).toEqual({ mode: 'exact', expected: 'Paris', ignoreCase: true, ignoreAccents: false });
  expect(rows[1]).toMatchObject({ systemPrompt: 'Sois bref.', temperature: 0.3, maxTokens: 400 });

  const [att] = await f.db.select().from(testAttachments);
  expect(att).toMatchObject({ testId: rows[1]!.id, originalName: 'carre.png', mime: 'image/png', size: SAMPLE_PNG.length });
  expect(await readFile(resolveAttachmentPath(f.dataDir, att!.storagePath))).toEqual(SAMPLE_PNG);

  const [suite] = await f.db.select().from(suites);
  expect(suite).toMatchObject({ name: 'Démarrage', description: 'Deux tests' });
  const members = await f.db.select().from(suiteTests).where(eq(suiteTests.suiteId, suite!.id)).orderBy(asc(suiteTests.position));
  // Test inconnu ignoré, ordre du jeu conservé.
  expect(members.map((m) => m.testId)).toEqual([rows[1]!.id, rows[0]!.id]);
});

test('une seule fois : un second démarrage ne recrée rien, même après suppression des tests', async () => {
  const f = await fixture(SEED);
  await seedTests({ db: f.db, dataDir: f.dataDir, now: NOW, seedDir: f.seedDir });
  await f.db.delete(suiteTests);
  await f.db.delete(testAttachments);
  await f.db.delete(tests);
  expect(await seedTests({ db: f.db, dataDir: f.dataDir, now: NOW, seedDir: f.seedDir })).toEqual({ status: 'skipped' });
  expect(await f.db.select().from(tests)).toHaveLength(0);
});

test('installation existante (tests déjà présents) : rien n’est ajouté, et le jeu ne sera plus jamais installé', async () => {
  const f = await fixture(SEED);
  await f.db.insert(tests).values({ id: '00000000-0000-4000-8000-000000000001', name: 'Le mien', category: 'X', tags: [], userPrompt: 'P', scoringMethod: 'manual', scoringConfig: {} });
  expect(await seedTests({ db: f.db, dataDir: f.dataDir, now: NOW, seedDir: f.seedDir })).toEqual({ status: 'skipped' });
  expect((await f.db.select().from(tests)).map((r) => r.name)).toEqual(['Le mien']);
  expect(await f.db.select().from(settings).where(eq(settings.key, 'tests.seeded_at'))).toHaveLength(1);
});

test('sans fichier tests.json : rien n’est fait ni noté (un jeu ajouté plus tard sera installé)', async () => {
  const f = await fixture();
  expect(await seedTests({ db: f.db, dataDir: f.dataDir, now: NOW, seedDir: f.seedDir })).toEqual({ status: 'absent' });
  expect(await f.db.select().from(settings).where(eq(settings.key, 'tests.seeded_at'))).toHaveLength(0);
});

test('jeu invalide (pièce jointe hors du dossier) : erreur, aucune ligne ni fichier laissé', async () => {
  const bad: SeedFile = { ...SEED, tests: [{ ...SEED.tests[1]!, attachments: [{ file: '../hors.png', originalName: 'x.png' }] }] };
  const f = await fixture(bad);
  await expect(seedTests({ db: f.db, dataDir: f.dataDir, now: NOW, seedDir: f.seedDir })).rejects.toThrow(/chemin refusé/);
  expect(await f.db.select().from(tests)).toHaveLength(0);
});

const CATALOG: SeedFile = {
  version: 1,
  providers: [
    { name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com' },
    { name: 'Maison', type: 'openai_compatible', baseUrl: 'https://llm.exemple.fr/v1', maxConcurrency: 4 },
  ],
  models: [
    { provider: 'Anthropic', apiModelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', color: '#D97757', inputPricePerM: 4, outputPricePerM: 20, supportsVision: true, supportsPdf: true },
    { provider: 'Maison', apiModelId: 'maison-1', displayName: 'Maison 1', color: '#123456' },
    { provider: 'Inconnu', apiModelId: 'x', displayName: 'X', color: '#000000' },
  ],
};

test('modèles : fournisseurs absents créés sans clé, modèles rattachés par nom, fournisseur inconnu ignoré ; une seule fois', async () => {
  const f = await fixture(CATALOG);
  await f.db.insert(providers).values({ id: '00000000-0000-4000-8000-0000000000aa', name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com' });
  expect(await seedModels({ db: f.db, now: NOW, seedDir: f.seedDir })).toEqual({ status: 'seeded', providers: 1, models: 2 });
  const maison = (await f.db.select().from(providers).where(eq(providers.name, 'Maison')))[0]!;
  expect(maison).toMatchObject({ type: 'openai_compatible', maxConcurrency: 4, apiKeyEncrypted: null, apiKeyLast4: null });
  const rows = await f.db.select().from(models).orderBy(asc(models.displayName));
  expect(rows.map((m) => [m.displayName, m.providerId])).toEqual([
    ['Claude Opus 5.5', '00000000-0000-4000-8000-0000000000aa'],
    ['Maison 1', maison.id],
  ]);
  expect(rows[0]).toMatchObject({ inputPricePerM: 4, outputPricePerM: 20, supportsVision: true, supportsPdf: true, enabled: true });
  await f.db.delete(models);
  expect(await seedModels({ db: f.db, now: NOW, seedDir: f.seedDir })).toEqual({ status: 'skipped' });
  expect(await f.db.select().from(models)).toHaveLength(0);
});

test('modèles déjà présents : rien n’est ajouté', async () => {
  const f = await fixture(CATALOG);
  const pid = '00000000-0000-4000-8000-0000000000bb';
  await f.db.insert(providers).values({ id: pid, name: 'Perso', type: 'openai_compatible', baseUrl: 'https://p.exemple.fr/v1' });
  await f.db.insert(models).values({ id: '00000000-0000-4000-8000-0000000000cc', providerId: pid, apiModelId: 'm', displayName: 'M', color: '#111111' });
  expect(await seedModels({ db: f.db, now: NOW, seedDir: f.seedDir })).toEqual({ status: 'skipped' });
  expect(await f.db.select().from(models)).toHaveLength(1);
});
