import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { poolOf } from '../src/db/client.js';
import { models, providers } from '../src/db/schema/catalog.js';
import { users } from '../src/db/schema/core.js';
import { aiUsage, results, runModels, runs, runTests } from '../src/db/schema/runs.js';
import { suites, suiteTests, testAttachments, tests } from '../src/db/schema/tests.js';
import { createTestDb } from './helpers/test-db.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
}, 60_000);

async function testDb() {
  const t = await createTestDb();
  cleanups.push(t.destroy);
  return t.db;
}

type TestDb = Awaited<ReturnType<typeof testDb>>;

/** Détail MariaDB : Drizzle enveloppe l'erreur, le message utile est dans `cause`. */
async function causeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return String((err as { cause?: Error }).cause?.message ?? err);
  }
  throw new Error('Une erreur était attendue.');
}

async function seed(db: TestDb) {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, email: 'a@example.test', name: 'A', role: 'admin', status: 'active' });
  const providerId = randomUUID();
  await db.insert(providers).values({ id: providerId, name: 'P', type: 'openai_compatible', baseUrl: 'https://p.example/v1' });
  const modelId = randomUUID();
  await db.insert(models).values({ id: modelId, providerId, apiModelId: 'm', displayName: 'M', color: '#112233' });
  const testId = randomUUID();
  await db.insert(tests).values({ id: testId, name: 'T', category: 'C', tags: ['a'], userPrompt: 'Bonjour', scoringMethod: 'manual', scoringConfig: {} });
  const runId = randomUUID();
  await db.insert(runs).values({
    id: runId,
    name: 'R',
    repetitions: 1,
    concurrency: 4,
    status: 'queued',
    weights: { quality: 50, speed: 20, cost: 20, reliability: 10 },
    createdBy: userId,
  });
  const runTestId = randomUUID();
  await db.insert(runTests).values({ id: runTestId, runId, testId, position: 0, snapshot: { name: 'T' } });
  return { userId, modelId, testId, runId, runTestId };
}

describe('schéma des tests, séries et consommation', () => {
  test('migration 0002 : les neuf tables existent', async () => {
    const db = await testDb();
    const names = ['tests', 'test_attachments', 'suites', 'suite_tests', 'runs', 'run_models', 'run_tests', 'results', 'ai_usage'];
    expect(names).toHaveLength(9);
    for (const table of names) {
      const [rows] = await poolOf(db).query(`SELECT COUNT(*) AS n FROM \`${table}\``);
      expect(Number((rows as { n: number }[])[0]!.n)).toBe(0);
    }
  });

  test('résultat unique par série, test, modèle et répétition', async () => {
    const db = await testDb();
    const s = await seed(db);
    const row = () => ({ id: randomUUID(), runId: s.runId, runTestId: s.runTestId, modelId: s.modelId, repetition: 1, status: 'pending' as const });
    await db.insert(results).values(row());
    expect(await causeOf(db.insert(results).values(row()))).toMatch(/Duplicate/);
    await db.insert(results).values({ ...row(), repetition: 2 });
  });

  test('un test référencé par une suite ou une série ne peut pas être supprimé en base (RESTRICT)', async () => {
    const db = await testDb();
    const s = await seed(db);
    expect(await causeOf(db.delete(tests).where(eq(tests.id, s.testId)))).toMatch(/foreign key/i);
    const suiteId = randomUUID();
    await db.insert(suites).values({ id: suiteId, name: 'S' });
    const t2 = randomUUID();
    await db.insert(tests).values({ id: t2, name: 'T2', category: 'C', tags: [], userPrompt: 'x', scoringMethod: 'manual', scoringConfig: {} });
    await db.insert(suiteTests).values({ suiteId, testId: t2, position: 0 });
    expect(await causeOf(db.delete(tests).where(eq(tests.id, t2)))).toMatch(/foreign key/i);
    // Un modèle utilisé reste lui aussi protégé.
    await db.insert(runModels).values({ runId: s.runId, modelId: s.modelId });
    expect(await causeOf(db.delete(models).where(eq(models.id, s.modelId)))).toMatch(/foreign key/i);
  });

  test('suppression en cascade : pièces jointes, suite, série', async () => {
    const db = await testDb();
    const s = await seed(db);
    await db.insert(results).values({ id: randomUUID(), runId: s.runId, runTestId: s.runTestId, modelId: s.modelId, repetition: 1, status: 'done' });
    await db.insert(aiUsage).values({ id: randomUUID(), origin: 'run', runId: s.runId, modelId: s.modelId, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, costUsd: 0.1 });
    await db.delete(runs).where(eq(runs.id, s.runId));
    expect(await db.select().from(results)).toHaveLength(0);
    expect(await db.select().from(runTests)).toHaveLength(0);
    const [usage] = await db.select().from(aiUsage);
    expect(usage!.runId).toBeNull();
    await db.insert(testAttachments).values({
      id: randomUUID(), testId: s.testId, originalName: 'a.png', mime: 'image/png', size: 10, storagePath: 'attachments/x/y', sha256: 'a'.repeat(64),
    });
    expect(await db.select().from(testAttachments)).toHaveLength(1);
  });

  test('décimaux relus en nombres', async () => {
    const db = await testDb();
    const s = await seed(db);
    const [t] = await db.select().from(tests).where(eq(tests.id, s.testId));
    expect(t!.temperature).toBe(0.2);
    expect(t!.maxTokens).toBe(1000);
    const id = randomUUID();
    await db.insert(results).values({
      id, runId: s.runId, runTestId: s.runTestId, modelId: s.modelId, repetition: 1, status: 'done', costUsd: 0.000123, tokensPerS: 42.5, autoScore: 7.5,
    });
    const [r] = await db.select().from(results).where(eq(results.id, id));
    expect(r!.costUsd).toBe(0.000123);
    expect(r!.tokensPerS).toBe(42.5);
    expect(r!.autoScore).toBe(7.5);
    expect(r!.scoreStatus).toBe('pending');
    expect(r!.tokensEstimated).toBe(false);
    const [run] = await db.select().from(runs).where(eq(runs.id, s.runId));
    expect(run!.modelsCostUsd).toBe(0);
    expect(typeof run!.judgeCostUsd).toBe('number');
  });
});
