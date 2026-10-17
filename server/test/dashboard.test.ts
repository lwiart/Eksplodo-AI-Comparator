import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { models } from '../src/db/schema/catalog.js';
import { manualScores, results, runs } from '../src/db/schema/runs.js';
import { suites } from '../src/db/schema/tests.js';
import { recordUsage } from '../src/modules/usage/usage.js';
import { buildTestApp, loginAs, seedModel, seedProvider, seedUser, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const created: TestApp[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

const QUALITY_ONLY = { quality: 100, speed: 0, cost: 0, reliability: 0 };

/** Horloge fixée au 20 mai 2026 (fuseau Europe/Paris : le mois en cours commence le 30 avril à 22 h UTC). */
async function setup() {
  const t = await buildTestApp({ fakeLlm: true, now: new Date('2026-05-20T10:00:00.000Z') });
  created.push(t);
  const adminRow = await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin', name: 'Alice Admin' });
  const userRow = await seedUser(t.db, { email: 'user@acme.fr', role: 'user', name: 'Ulysse Util' });
  const admin = await loginAs(t.app, 'admin@acme.fr', PW);
  const user = await loginAs(t.app, 'user@acme.fr', PW);
  type Session = typeof admin;
  const call = (method: 'GET' | 'POST', url: string, s: Session, payload?: unknown) =>
    t.app.inject({ method, url, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });

  const provider = await seedProvider(t.db, { name: 'Fournisseur Alpha' });
  const mA = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-a', displayName: 'Modèle A', color: '#111111' });
  const mB = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-b', displayName: 'Modèle B', color: '#222222' });
  const judge = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-j', displayName: 'Juge', color: '#333333' });

  const makeTest = async (name: string, category: string, manual = false) => {
    const body = manual
      ? { name, category, userPrompt: `Question ${name}`, scoringMethod: 'manual', scoringConfig: {} }
      : { name, category, userPrompt: `Question ${name}`, scoringMethod: 'expected', scoringConfig: { mode: 'exact', expected: 'Paris' } };
    const res = await call('POST', '/api/tests', admin, body);
    expect(res.statusCode).toBe(201);
    return res.json().test.id as string;
  };
  const makeSuite = async (name: string) => {
    const id = randomUUID();
    await t.db.insert(suites).values({ id, name });
    return id;
  };
  /** Série à la date de création donnée ; `scores` : note automatique de chaque modèle (réponse réussie). */
  const makeRun = async (
    name: string,
    testId: string,
    scores: [{ id: string }, number][],
    opts: {
      status?: 'completed' | 'running';
      createdAt?: Date;
      completedAt?: Date;
      suiteId?: string;
      judgeModelId?: string;
      modelsCostUsd?: number;
      judgeCostUsd?: number;
    } = {},
  ) => {
    const res = await call('POST', '/api/runs', admin, { name, testIds: [testId], modelIds: scores.map(([m]) => m.id), repetitions: 1 });
    expect(res.statusCode).toBe(201);
    const runId = res.json().run.id as string;
    for (const [m, score] of scores) {
      await t.db
        .update(results)
        .set({ status: 'done', attempts: 1, responseText: 'x', ttftMs: 100, tokensPerS: 50, scoreStatus: 'done', autoScore: score, completedAt: new Date() })
        .where(and(eq(results.runId, runId), eq(results.modelId, m.id)));
    }
    await t.db
      .update(runs)
      .set({
        status: opts.status ?? 'completed',
        weights: QUALITY_ONLY,
        completedAt: opts.completedAt ?? opts.createdAt ?? new Date(),
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        ...(opts.suiteId ? { suiteId: opts.suiteId } : {}),
        ...(opts.judgeModelId ? { judgeModelId: opts.judgeModelId } : {}),
        ...(opts.modelsCostUsd !== undefined ? { modelsCostUsd: opts.modelsCostUsd } : {}),
        ...(opts.judgeCostUsd !== undefined ? { judgeCostUsd: opts.judgeCostUsd } : {}),
      })
      .where(eq(runs.id, runId));
    return runId;
  };
  const rate = async (runId: string, modelId: string, raterId: string, score: number) => {
    const [r] = await t.db.select({ id: results.id }).from(results).where(and(eq(results.runId, runId), eq(results.modelId, modelId)));
    await t.db.insert(manualScores).values({ id: randomUUID(), resultId: r!.id, userId: raterId, score });
  };
  return { t, admin, user, call, provider, mA, mB, judge, makeTest, makeSuite, makeRun, rate, adminId: adminRow.id, userId: userRow.id };
}

test('Admin : chiffres clés, dépense du mois avec la part du juge, 5 dernières séries avec vainqueur', async () => {
  const { t, admin, call, mA, mB, judge, makeTest, makeSuite, makeRun } = await setup();
  const test1 = await makeTest('Capitale', 'Culture');
  const suiteId = await makeSuite('Culture générale');

  // Modèle désactivé (juge) et fournisseur sans modèle actif : hors des fournisseurs actifs ; fournisseur désactivé : ignoré aussi.
  await t.db.update(models).set({ enabled: false }).where(eq(models.id, judge.id));
  const idle = await seedProvider(t.db, { name: 'Fournisseur Beta' });
  await seedModel(t.db, { providerId: idle.id, apiModelId: 'off', displayName: 'Modèle éteint', enabled: false });
  const off = await seedProvider(t.db, { name: 'Fournisseur Gamma', enabled: false });
  await seedModel(t.db, { providerId: off.id, apiModelId: 'g', displayName: 'Modèle Gamma' });

  // 30 avril 21 h 30 UTC = 23 h 30 à Paris (avril) ; 30 avril 22 h 30 UTC = 0 h 30 le 1er mai à Paris.
  const april = await makeRun('Série d’avril', test1, [[mA, 5], [mB, 9]], { createdAt: new Date('2026-04-30T21:30:00.000Z') });
  await makeRun('Série de mai 1', test1, [[mA, 4]], { createdAt: new Date('2026-04-30T22:30:00.000Z') });
  await makeRun('Série de mai 2', test1, [[mA, 6], [mB, 2]], { createdAt: new Date('2026-05-02T10:00:00.000Z') });
  await makeRun('Série de mai 3', test1, [[mA, 6], [mB, 2]], { createdAt: new Date('2026-05-03T10:00:00.000Z') });
  await makeRun('Série de mai 4', test1, [[mA, 6], [mB, 2]], { createdAt: new Date('2026-05-04T10:00:00.000Z') });
  const latest = await makeRun('Série de mai 5', test1, [[mA, 3], [mB, 8]], {
    createdAt: new Date('2026-05-10T10:00:00.000Z'),
    suiteId,
    modelsCostUsd: 0.5,
    judgeCostUsd: 0.25,
    status: 'running',
  });

  await recordUsage(t.db, { origin: 'run', runId: latest, modelId: mA.id, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, costUsd: 1.5, now: new Date('2026-05-10T10:00:00.000Z') });
  await recordUsage(t.db, { origin: 'judge', runId: latest, modelId: judge.id, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, costUsd: 0.5, now: new Date('2026-05-11T10:00:00.000Z') });
  // Mois précédent (avril, heure de Paris) : exclu.
  await recordUsage(t.db, { origin: 'run', runId: april, modelId: mA.id, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, costUsd: 10, now: new Date('2026-04-30T21:30:00.000Z') });

  const res = await call('GET', '/api/dashboard', admin);
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.runs).toEqual({ total: 6, thisMonth: 5 });
  expect(body.models).toEqual({ tracked: 3, providers: 1 });
  expect(body.spend).toEqual({ monthUsd: 2, judgeUsd: 0.5 });
  expect(body.recentRuns.map((r: { name: string }) => r.name)).toEqual(['Série de mai 5', 'Série de mai 4', 'Série de mai 3', 'Série de mai 2', 'Série de mai 1']);
  expect(body.recentRuns[0]).toEqual({
    id: latest,
    name: 'Série de mai 5',
    suiteName: 'Culture générale',
    status: 'running',
    modelCount: 2,
    winner: { name: 'Modèle B', color: '#222222' },
    costUsd: 0.75,
    completedAt: '2026-05-10T10:00:00.000Z',
    createdAt: '2026-05-10T10:00:00.000Z',
  });
  expect(body.recentRuns[1].winner).toEqual({ name: 'Modèle A', color: '#111111' });
  expect(body.recentRuns[4].suiteName).toBeNull();
  // Seule la série terminée d'une suite compte pour l'évolution : ici la seule série de la suite est en cours.
  expect(body.evolutionSuites).toEqual([]);
});

test('Utilisateur : spend null ; vainqueur et évolution sans les notes manuelles des questions qu’il n’a pas notées', async () => {
  const { admin, user, call, mA, mB, makeTest, makeSuite, makeRun, rate, adminId } = await setup();
  const manual = await makeTest('Poème', 'Écriture', true);
  const suiteId = await makeSuite('Poèmes');
  const run = await makeRun('Poèmes de mai', manual, [[mA, 0], [mB, 0]], { createdAt: new Date('2026-05-05T10:00:00.000Z'), suiteId });
  // L'Admin a noté (B gagne) ; l'Utilisateur n'a rien noté.
  await rate(run, mA.id, adminId, 2);
  await rate(run, mB.id, adminId, 9);

  const asAdmin = (await call('GET', '/api/dashboard', admin)).json();
  expect(asAdmin.recentRuns[0].winner).toEqual({ name: 'Modèle B', color: '#222222' });
  expect(asAdmin.spend).toEqual({ monthUsd: 0, judgeUsd: 0 });

  const asUser = (await call('GET', '/api/dashboard', user)).json();
  expect(asUser.spend).toBeNull();
  expect(asUser.recentRuns[0].winner).toBeNull();
  expect(asUser.evolutionSuites).toEqual([{ id: suiteId, name: 'Poèmes' }]);

  const evoAdmin = (await call('GET', `/api/dashboard/evolution?suiteId=${suiteId}`, admin)).json();
  expect(evoAdmin.series.map((s: { name: string; points: unknown }) => [s.name, s.points])).toEqual([['Modèle A', [2]], ['Modèle B', [9]]]);
  const evoUser = (await call('GET', `/api/dashboard/evolution?suiteId=${suiteId}`, user)).json();
  expect(evoUser.series.map((s: { name: string; points: unknown }) => [s.name, s.points])).toEqual([['Modèle A', [null]], ['Modèle B', [null]]]);
});

test('toScore : nombre de questions incomplètes pour ce compte et nom de la série la plus récente', async () => {
  const { admin, user, call, mA, mB, makeTest, makeRun, rate, userId } = await setup();
  const q1 = await makeTest('Poème', 'Écriture', true);
  const q2 = await makeTest('Haïku', 'Écriture', true);
  const old = await makeRun('Série ancienne', q1, [[mA, 0], [mB, 0]], { createdAt: new Date('2026-05-01T10:00:00.000Z') });
  await makeRun('Série récente', q2, [[mA, 0], [mB, 0]], { createdAt: new Date('2026-05-08T10:00:00.000Z') });

  expect((await call('GET', '/api/dashboard', user)).json().toScore).toEqual({ questions: 2, runName: 'Série récente' });
  expect((await call('GET', '/api/dashboard', admin)).json().toScore).toEqual({ questions: 2, runName: 'Série récente' });

  // L'Utilisateur note entièrement la question de la série ancienne : il lui en reste une.
  await rate(old, mA.id, userId, 5);
  await rate(old, mB.id, userId, 6);
  expect((await call('GET', '/api/dashboard', user)).json().toScore).toEqual({ questions: 1, runName: 'Série récente' });
  // Question incomplète pour l'Admin, qui n'a rien noté.
  expect((await call('GET', '/api/dashboard', admin)).json().toScore).toEqual({ questions: 2, runName: 'Série récente' });
});

test('évolution : 6 dernières séries terminées de la suite, ordre chronologique, juge par série, null pour un modèle absent', async () => {
  const { admin, call, mA, mB, judge, makeTest, makeSuite, makeRun } = await setup();
  const test1 = await makeTest('Capitale', 'Culture');
  const suiteId = await makeSuite('Culture générale');
  const otherSuite = await makeSuite('Autre suite');
  const day = (n: number) => new Date(Date.UTC(2026, 3, n, 10));

  // 7 séries terminées : la plus ancienne sort de la fenêtre. B n'est absent que de la série 3.
  const ids: string[] = [];
  for (let n = 1; n <= 7; n++) {
    const scores: [{ id: string }, number][] = n === 3 ? [[mA, n]] : [[mA, n], [mB, 10 - n]];
    ids.push(await makeRun(`Série ${n}`, test1, scores, { createdAt: day(n), suiteId, ...(n % 2 === 0 ? { judgeModelId: judge.id } : {}) }));
  }
  await makeRun('Hors suite', test1, [[mA, 1]], { createdAt: day(20), suiteId: otherSuite });

  const res = await call('GET', `/api/dashboard/evolution?suiteId=${suiteId}`, admin);
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.suite).toEqual({ id: suiteId, name: 'Culture générale' });
  expect(body.runs).toEqual(
    [2, 3, 4, 5, 6, 7].map((n) => ({
      id: ids[n - 1],
      name: `Série ${n}`,
      completedAt: day(n).toISOString(),
      judgeName: n % 2 === 0 ? 'Juge' : null,
    })),
  );
  expect(body.series).toEqual([
    { modelId: mA.id, name: 'Modèle A', color: '#111111', points: [2, 3, 4, 5, 6, 7] },
    { modelId: mB.id, name: 'Modèle B', color: '#222222', points: [8, null, 6, 5, 4, 3] },
  ]);

  const dash = (await call('GET', '/api/dashboard', admin)).json();
  expect(dash.evolutionSuites).toEqual([
    { id: otherSuite, name: 'Autre suite' },
    { id: suiteId, name: 'Culture générale' },
  ]);
});

test('évolution : suite inconnue → 404 ; série en cours exclue', async () => {
  const { admin, user, call, mA, makeTest, makeSuite, makeRun } = await setup();
  const test1 = await makeTest('Capitale', 'Culture');
  const suiteId = await makeSuite('Culture générale');
  await makeRun('Terminée', test1, [[mA, 7]], { createdAt: new Date('2026-05-01T10:00:00.000Z'), suiteId });
  await makeRun('En cours', test1, [[mA, 1]], { createdAt: new Date('2026-05-02T10:00:00.000Z'), suiteId, status: 'running' });

  const unknown = await call('GET', `/api/dashboard/evolution?suiteId=${randomUUID()}`, user);
  expect(unknown.statusCode).toBe(404);
  expect(unknown.json().error.code).toBe('not_found');
  expect((await call('GET', '/api/dashboard/evolution?suiteId=pas-un-uuid', admin)).statusCode).toBe(400);

  const res = await call('GET', `/api/dashboard/evolution?suiteId=${suiteId}`, user);
  expect(res.statusCode).toBe(200);
  expect(res.json().runs.map((r: { name: string }) => r.name)).toEqual(['Terminée']);
  expect(res.json().series[0].points).toEqual([7]);
});
