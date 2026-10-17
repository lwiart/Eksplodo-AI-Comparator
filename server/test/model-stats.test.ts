import { and, eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { models } from '../src/db/schema/catalog.js';
import { results, runs } from '../src/db/schema/runs.js';
import { buildTestApp, loginAs, seedModel, seedProvider, seedUser, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const created: TestApp[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

async function setup() {
  const t = await buildTestApp({ fakeLlm: true });
  created.push(t);
  await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin', name: 'Alice Admin' });
  await seedUser(t.db, { email: 'user@acme.fr', role: 'user', name: 'Ulysse Util' });
  const admin = await loginAs(t.app, 'admin@acme.fr', PW);
  const user = await loginAs(t.app, 'user@acme.fr', PW);
  type Session = typeof admin;
  const call = (method: 'GET' | 'POST', url: string, s: Session, payload?: unknown) =>
    t.app.inject({ method, url, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });

  const provider = await seedProvider(t.db, { name: 'Fournisseur Alpha' });
  const mA = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-a', displayName: 'Modèle A' });
  const mB = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-b', displayName: 'Modèle B' });
  const mC = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-c', displayName: 'Modèle C' });

  const makeTest = async (name: string, category: string) => {
    const res = await call('POST', '/api/tests', admin, { name, category, userPrompt: `Question ${name}`, scoringMethod: 'expected', scoringConfig: { mode: 'exact', expected: 'Paris' } });
    expect(res.statusCode).toBe(201);
    return res.json().test.id as string;
  };
  /** Série terminée à la date donnée ; `perf` : note automatique, premier token et débit de chaque modèle (réussi). */
  const makeRun = async (
    name: string,
    testId: string,
    perf: [{ id: string }, number, number, number][],
    opts: { status?: 'completed' | 'running'; completedAt?: Date; weights?: { quality: number; speed: number; cost: number; reliability: number } } = {},
  ) => {
    const res = await call('POST', '/api/runs', admin, { name, testIds: [testId], modelIds: perf.map(([m]) => m.id), repetitions: 1 });
    expect(res.statusCode).toBe(201);
    const runId = res.json().run.id as string;
    for (const [m, score, ttftMs, tokensPerS] of perf) {
      await t.db
        .update(results)
        .set({ status: 'done', attempts: 1, responseText: 'x', ttftMs, tokensPerS, scoreStatus: 'done', autoScore: score, completedAt: new Date() })
        .where(and(eq(results.runId, runId), eq(results.modelId, m.id)));
    }
    await t.db
      .update(runs)
      .set({ status: opts.status ?? 'completed', completedAt: opts.completedAt ?? new Date(), ...(opts.weights ? { weights: opts.weights } : {}) })
      .where(eq(runs.id, runId));
    return runId;
  };
  return { t, admin, user, call, mA, mB, mC, makeTest, makeRun };
}

test('modèle sans série : tout nul, historique vide', async () => {
  const { admin, call, mC } = await setup();
  const res = await call('GET', `/api/models/${mC.id}/stats`, admin);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    stats: { quality: null, medianTtftMs: null, ttftRank: null, medianTokensPerS: null, tpsRank: null, reliability: null, radar: [], history: [] },
  });
});

test('deux séries : qualité moyenne, rangs, radar et historique (série non terminée ignorée)', async () => {
  const { admin, call, mA, mB, makeTest, makeRun } = await setup();
  const culture = await makeTest('Capitale', 'Culture');
  const maths = await makeTest('Calcul', 'Maths');
  const older = await makeRun('Série de mars', culture, [[mA, 10, 100, 50], [mB, 0, 200, 100]], { completedAt: new Date('2026-03-01T10:00:00.000Z') });
  const newer = await makeRun('Série d’avril', maths, [[mA, 6, 300, 60], [mB, 8, 100, 40]], {
    completedAt: new Date('2026-04-01T10:00:00.000Z'),
    weights: { quality: 100, speed: 0, cost: 0, reliability: 0 },
  });
  await makeRun('Série en cours', culture, [[mA, 0, 1, 1000]], { status: 'running' });

  const res = await call('GET', `/api/models/${mA.id}/stats`, admin);
  expect(res.statusCode).toBe(200);
  expect(res.json().stats).toEqual({
    quality: 8,
    medianTtftMs: 200,
    ttftRank: { rank: 2, of: 2 },
    medianTokensPerS: 55,
    tpsRank: { rank: 2, of: 2 },
    reliability: 10,
    radar: [
      { category: 'Maths', model: 6, average: 7 },
      { category: 'Culture', model: 10, average: 5 },
    ],
    history: [
      { runId: newer, runName: 'Série d’avril', completedAt: '2026-04-01T10:00:00.000Z', rank: 2, of: 2, quality: 6, global: 6 },
      { runId: older, runName: 'Série de mars', completedAt: '2026-03-01T10:00:00.000Z', rank: 1, of: 2, quality: 10, global: 9 },
    ],
  });

  // Modèle B : plus rapide en premier token (médiane 150 contre 200) et en débit (70 contre 55).
  const b = await call('GET', `/api/models/${mB.id}/stats`, admin);
  expect(b.json().stats.ttftRank).toEqual({ rank: 1, of: 2 });
  expect(b.json().stats.tpsRank).toEqual({ rank: 1, of: 2 });
});

test('Utilisateur : modèle désactivé → 404 ; Admin : accès', async () => {
  const { t, admin, user, call, mA } = await setup();
  await t.db.update(models).set({ enabled: false }).where(eq(models.id, mA.id));
  const asUser = await call('GET', `/api/models/${mA.id}/stats`, user);
  expect(asUser.statusCode).toBe(404);
  const asAdmin = await call('GET', `/api/models/${mA.id}/stats`, admin);
  expect(asAdmin.statusCode).toBe(200);
});
