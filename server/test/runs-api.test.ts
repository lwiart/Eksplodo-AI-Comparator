import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { auditLog } from '../src/db/schema/core.js';
import { jobs } from '../src/db/schema/jobs.js';
import { results, runModels, runTests, runs } from '../src/db/schema/runs.js';
import { testAttachments } from '../src/db/schema/tests.js';
import { enqueueRunJob } from '../src/modules/runs/run-job.js';
import { buildTestApp, loginAs, seedModel, seedProvider, seedUser, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const KEY = 'sk-test-0123456789abcdef';
const created: TestApp[] = [];

async function setup() {
  const t = await buildTestApp();
  created.push(t);
  const adminRow = await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin' });
  await seedUser(t.db, { email: 'user@acme.fr', role: 'user' });
  const admin = await loginAs(t.app, 'admin@acme.fr', PW);
  const user = await loginAs(t.app, 'user@acme.fr', PW);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, s: typeof admin, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const api = {
    get: (url: string, s = admin) => call('GET', url, s),
    post: (url: string, payload: unknown = {}, s = admin) => call('POST', url, s, payload),
    put: (url: string, payload: unknown, s = admin) => call('PUT', url, s, payload),
    del: (url: string, s = admin) => call('DELETE', url, s),
  };
  const provider = await seedProvider(t.db, { apiKey: KEY });
  const modelA = await seedModel(t.db, {
    providerId: provider.id,
    displayName: 'Alpha',
    color: '#111111',
    inputPricePerM: 1,
    outputPricePerM: 2,
    supportsVision: true,
  });
  const modelB = await seedModel(t.db, { providerId: provider.id, displayName: 'Bêta', color: '#222222' });

  type TestOpts = { scoringMethod?: 'manual' | 'judge' | 'expected'; userPrompt?: string };
  const makeTest = async (name: string, opts: TestOpts = {}): Promise<string> => {
    const method = opts.scoringMethod ?? 'manual';
    const scoringConfig =
      method === 'judge' ? { criteria: 'Exactitude' } : method === 'expected' ? { mode: 'exact', expected: 'Paris' } : {};
    const res = await api.post('/api/tests', {
      name,
      category: 'Culture',
      userPrompt: opts.userPrompt ?? `Question ${name}`,
      scoringMethod: method,
      scoringConfig,
    });
    expect(res.statusCode).toBe(201);
    return res.json().test.id as string;
  };
  const runBody = (testIds: string[], modelIds: string[], extra: Record<string, unknown> = {}) => ({
    name: 'Série test',
    testIds,
    modelIds,
    repetitions: 1,
    concurrency: 2,
    ...extra,
  });
  return { ...t, adminRow, admin, user, ...api, provider, modelA, modelB, makeTest, runBody };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

type Setup = Awaited<ReturnType<typeof setup>>;

async function countOf(t: Setup, table: typeof runs | typeof results | typeof jobs): Promise<number> {
  const [row] = await t.db.select({ n: count() }).from(table);
  return Number(row!.n);
}

async function activeJobs(t: Setup, runId: string) {
  return t.db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.type, 'run_execute'),
        inArray(jobs.status, ['queued', 'running']),
        sql`JSON_VALUE(${jobs.payload}, '$.runId') = ${runId}`,
      ),
    );
}

test('estimate ne crée rien', async () => {
  const t = await setup();
  const a = await t.makeTest('A', { userPrompt: 'x'.repeat(400) });
  const b = await t.makeTest('B');
  const res = await t.post('/api/runs/estimate', t.runBody([a, b], [t.modelA.id, t.modelB.id], { repetitions: 3 }));
  expect(res.statusCode).toBe(200);
  const estimate = res.json().estimate;
  expect(estimate.calls).toBe(2 * 2 * 3);
  expect(estimate.unsupported).toBe(0);
  // Alpha : test A = 100 tokens d'entrée × 1 $ + 1 000 × 2 $ ; par million, × 3 répétitions (plus le test B).
  expect(estimate.perModel.find((p: { modelId: string }) => p.modelId === t.modelA.id).maxCostUsd).toBeGreaterThan(0);
  // Aucun historique : 10 s par appel, 12 appels, concurrence 2.
  expect(estimate.durationSeconds).toBe(60);
  expect(await countOf(t, runs)).toBe(0);
  expect(await countOf(t, results)).toBe(0);
  expect(await countOf(t, jobs)).toBe(0);
});

test('estimate : durée tirée de la médiane historique de total_ms des résultats done', async () => {
  const t = await setup();
  const [a, b, c] = [await t.makeTest('A'), await t.makeTest('B'), await t.makeTest('C')];
  const run = (await t.post('/api/runs', t.runBody([a, b, c], [t.modelA.id]))).json().run;
  const rows = await t.db.select().from(results).where(eq(results.runId, run.id));
  const durations = [1000, 3000, 50_000];
  for (const [i, r] of rows.entries()) {
    await t.db.update(results).set({ status: 'done', totalMs: durations[i] }).where(eq(results.id, r.id));
  }
  // Alpha : médiane 3 s × 3 appels ; Bêta sans historique : 10 s × 3 appels ; concurrence 2.
  const res = await t.post('/api/runs/estimate', t.runBody([a, b, c], [t.modelA.id, t.modelB.id]));
  expect(res.statusCode).toBe(200);
  expect(res.json().estimate.durationSeconds).toBe((3 * 3 + 3 * 10) / 2);
});

test('créer une série : instantanés, résultats, tâche run_execute unique, statut queued', async () => {
  const t = await setup();
  const a = await t.makeTest('A');
  const b = await t.makeTest('B', { scoringMethod: 'expected' });
  const res = await t.post(
    '/api/runs',
    t.runBody([b, a], [t.modelA.id, t.modelB.id], { repetitions: 2, budgetUsd: 5, weights: { quality: 40, speed: 30, cost: 20, reliability: 10 } }),
  );
  expect(res.statusCode).toBe(201);
  const run = res.json().run;
  expect(run).toMatchObject({
    name: 'Série test',
    status: 'queued',
    pauseReason: null,
    suiteName: null,
    modelCount: 2,
    testCount: 2,
    repetitions: 2,
    judgeModelName: null,
    modelsCostUsd: 0,
    judgeCostUsd: 0,
    budgetUsd: 5,
    startedAt: null,
    completedAt: null,
    counts: { pending: 8, running: 0, done: 0, error: 0, timeout: 0, unsupported: 0, total: 8 },
  });
  expect(await countOf(t, results)).toBe(2 * 2 * 2);

  const [row] = await t.db.select().from(runs).where(eq(runs.id, run.id));
  expect(row!.weights).toEqual({ quality: 40, speed: 30, cost: 20, reliability: 10 });
  expect(row!.concurrency).toBe(2);
  expect(row!.createdBy).toBe(t.adminRow.id);

  const snaps = await t.db.select().from(runTests).where(eq(runTests.runId, run.id)).orderBy(asc(runTests.position));
  expect(snaps.map((s) => [s.testId, s.position, s.snapshot.name])).toEqual([
    [b, 0, 'B'],
    [a, 1, 'A'],
  ]);
  expect(snaps[0]!.snapshot.scoringMethod).toBe('expected');
  const members = await t.db.select().from(runModels).where(eq(runModels.runId, run.id));
  expect(members.map((m) => m.modelId).sort()).toEqual([t.modelA.id, t.modelB.id].sort());

  // Test manuel → `awaiting_manual` ; test à réponse attendue → `pending`.
  const rows = await t.db.select().from(results).where(eq(results.runId, run.id));
  const manualRunTest = snaps.find((s) => s.testId === a)!.id;
  for (const r of rows) {
    expect(r.status).toBe('pending');
    expect(r.scoreStatus).toBe(r.runTestId === manualRunTest ? 'awaiting_manual' : 'pending');
  }
  expect(new Set(rows.map((r) => r.repetition))).toEqual(new Set([1, 2]));

  const active = await activeJobs(t, run.id);
  expect(active).toHaveLength(1);
  expect(active[0]!.payload).toEqual({ runId: run.id });
  expect(row!.activeJobId).toBe(active[0]!.id);

  const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, 'run_created'));
  expect(audits).toHaveLength(1);
  expect(audits[0]!.targetId).toBe(run.id);

  // Pondération par défaut.
  const def = await t.post('/api/runs', t.runBody([a], [t.modelA.id]));
  const [defRow] = await t.db.select().from(runs).where(eq(runs.id, def.json().run.id));
  expect(defRow!.weights).toEqual({ quality: 50, speed: 20, cost: 20, reliability: 10 });
});

test('série issue d\'une suite : ordre de la suite et nom de la suite', async () => {
  const t = await setup();
  const [a, b, c] = [await t.makeTest('A'), await t.makeTest('B'), await t.makeTest('C')];
  const suite = (await t.post('/api/suites', { name: 'Ma suite', testIds: [c, a, b] })).json().suite;
  const res = await t.post('/api/runs', t.runBody([a, b, c], [t.modelA.id], { suiteId: suite.id }));
  expect(res.statusCode).toBe(201);
  expect(res.json().run.suiteName).toBe('Ma suite');
  const snaps = await t.db.select().from(runTests).where(eq(runTests.runId, res.json().run.id)).orderBy(asc(runTests.position));
  expect(snaps.map((s) => s.testId)).toEqual([c, a, b]);
});

test('image + modèle sans vision → résultat unsupported dès la création', async () => {
  const t = await setup();
  const a = await t.makeTest('Image');
  await t.db.insert(testAttachments).values({
    id: randomUUID(),
    testId: a,
    originalName: 'photo.png',
    mime: 'image/png',
    size: 10,
    storagePath: `attachments/${a}/x`,
    sha256: '0'.repeat(64),
  });
  const res = await t.post('/api/runs', t.runBody([a], [t.modelA.id, t.modelB.id]));
  expect(res.statusCode).toBe(201);
  expect(res.json().run.counts).toMatchObject({ pending: 1, unsupported: 1, total: 2 });
  const rows = await t.db.select().from(results).where(eq(results.runId, res.json().run.id));
  const byModel = new Map(rows.map((r) => [r.modelId, r]));
  expect(byModel.get(t.modelA.id)).toMatchObject({ status: 'pending', scoreStatus: 'awaiting_manual' });
  // Non supporté : la notation l'ignore, `scoreStatus` reste `pending`.
  expect(byModel.get(t.modelB.id)).toMatchObject({ status: 'unsupported', scoreStatus: 'pending' });
  const [snap] = await t.db.select().from(runTests).where(eq(runTests.runId, res.json().run.id));
  expect(snap!.snapshot.attachments).toHaveLength(1);
});

test('modifier puis archiver le test après création : instantané inchangé', async () => {
  const t = await setup();
  const a = await t.makeTest('Origine');
  const run = (await t.post('/api/runs', t.runBody([a], [t.modelA.id]))).json().run;
  const upd = await t.put(`/api/tests/${a}`, {
    name: 'Renommé',
    category: 'Autre',
    userPrompt: 'Nouvelle question',
    scoringMethod: 'manual',
    scoringConfig: {},
  });
  expect(upd.statusCode).toBe(200);
  expect((await t.del(`/api/tests/${a}`)).json().outcome).toBe('archived');
  const res = await t.get(`/api/runs/${run.id}/results`);
  expect(res.statusCode).toBe(200);
  expect(res.json().results).toHaveLength(1);
  expect(res.json().results[0]).toMatchObject({ testName: 'Origine', category: 'Culture', modelName: 'Alpha', color: '#111111' });

  // Un test archivé ne peut plus entrer dans une nouvelle série.
  const refused = await t.post('/api/runs', t.runBody([a], [t.modelA.id]));
  expect(refused.statusCode).toBe(400);
  expect(refused.json().error.code).toBe('test_not_found');
});

test('enqueueRunJob appelé deux fois en parallèle → une seule tâche active', async () => {
  const t = await setup();
  const a = await t.makeTest('A');
  const run = (await t.post('/api/runs', t.runBody([a], [t.modelA.id]))).json().run;
  const [first] = await activeJobs(t, run.id);
  // Tâche active réutilisée.
  expect(await enqueueRunJob(t.db, run.id, t.clock.now())).toBe(first!.id);

  // Tâche terminée : deux appels simultanés n'en créent qu'une nouvelle.
  await t.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, first!.id));
  const [x, y] = await Promise.all([enqueueRunJob(t.db, run.id, t.clock.now()), enqueueRunJob(t.db, run.id, t.clock.now())]);
  expect(x).toBe(y);
  expect(x).not.toBe(first!.id);
  const active = await activeJobs(t, run.id);
  expect(active.map((j) => j.id)).toEqual([x]);
  const [row] = await t.db.select().from(runs).where(eq(runs.id, run.id));
  expect(row!.activeJobId).toBe(x);
});

test('modèle indisponible (clé manquante) → 409 model_unavailable ; test juge sans juge → 400 judge_required', async () => {
  const t = await setup();
  const a = await t.makeTest('A');
  const j = await t.makeTest('Juge', { scoringMethod: 'judge' });
  const keyless = await seedProvider(t.db, {});
  const orphan = await seedModel(t.db, { providerId: keyless.id, displayName: 'Sans clé' });
  const disabled = await seedModel(t.db, { providerId: t.provider.id, displayName: 'Inactif', enabled: false });

  const noKey = await t.post('/api/runs', t.runBody([a], [t.modelA.id, orphan.id]));
  expect(noKey.statusCode).toBe(409);
  expect(noKey.json().error.code).toBe('model_unavailable');
  expect((await t.post('/api/runs', t.runBody([a], [disabled.id]))).json().error.code).toBe('model_unavailable');
  expect((await t.post('/api/runs/estimate', t.runBody([a], [orphan.id]))).statusCode).toBe(409);

  const noJudge = await t.post('/api/runs', t.runBody([a, j], [t.modelA.id]));
  expect(noJudge.statusCode).toBe(400);
  expect(noJudge.json().error.code).toBe('judge_required');

  const badJudge = await t.post('/api/runs', t.runBody([j], [t.modelA.id], { judgeModelId: orphan.id }));
  expect(badJudge.statusCode).toBe(409);
  expect(badJudge.json().error.code).toBe('model_unavailable');

  const unknown = await t.post('/api/runs', t.runBody([randomUUID()], [t.modelA.id]));
  expect(unknown.statusCode).toBe(400);
  expect(unknown.json().error.code).toBe('test_not_found');

  const weights = await t.post('/api/runs', t.runBody([a], [t.modelA.id], { weights: { quality: 50, speed: 20, cost: 20, reliability: 0 } }));
  expect(weights.statusCode).toBe(400);
  expect(weights.json().error.code).toBe('validation');

  const ok = await t.post('/api/runs', t.runBody([a, j], [t.modelA.id], { judgeModelId: t.modelB.id }));
  expect(ok.statusCode).toBe(201);
  expect(ok.json().run.judgeModelName).toBe('Bêta');
  expect(await countOf(t, runs)).toBe(1);
});

test('progress : compteurs, matrice test × modèle et activité', async () => {
  const t = await setup();
  const a = await t.makeTest('A');
  const b = await t.makeTest('B');
  const run = (await t.post('/api/runs', t.runBody([a, b], [t.modelA.id, t.modelB.id], { repetitions: 2 }))).json().run;
  const snaps = await t.db.select().from(runTests).where(eq(runTests.runId, run.id)).orderBy(asc(runTests.position));
  const [rtA, rtB] = [snaps[0]!.id, snaps[1]!.id];
  const rows = await t.db.select().from(results).where(eq(results.runId, run.id));
  const find = (rt: string, model: string, rep: number) =>
    rows.find((r) => r.runTestId === rt && r.modelId === model && r.repetition === rep)!.id;
  const base = t.clock.now().getTime();
  const started = new Date(base);
  await t.db.update(runs).set({ status: 'running', startedAt: started, modelsCostUsd: 0.03 }).where(eq(runs.id, run.id));
  const set = (id: string, values: Partial<typeof results.$inferInsert>) => t.db.update(results).set(values).where(eq(results.id, id));
  await set(find(rtA, t.modelA.id, 1), { status: 'done', totalMs: 2000, costUsd: 0.01, completedAt: new Date(base + 1000) });
  await set(find(rtA, t.modelB.id, 1), { status: 'done', totalMs: 4000, costUsd: 0.02, completedAt: new Date(base + 3000) });
  await set(find(rtB, t.modelA.id, 1), { status: 'error', errorCode: 'provider_error', completedAt: new Date(base + 2000) });
  await set(find(rtB, t.modelB.id, 1), { status: 'running' });
  t.clock.advance(10_000);

  const res = await t.get(`/api/runs/${run.id}/progress`);
  expect(res.statusCode).toBe(200);
  const p = res.json().progress;
  expect(p).toMatchObject({
    status: 'running',
    pauseReason: null,
    counts: { pending: 4, running: 1, done: 2, error: 1, timeout: 0, unsupported: 0, total: 8 },
    modelsCostUsd: 0.03,
    judgeCostUsd: 0,
    budgetUsd: null,
    startedAt: started.toISOString(),
    elapsedMs: 10_000,
  });
  // 5 restants × 3 000 ms de moyenne ÷ concurrence 2 = 7,5 s.
  expect(p.etaSeconds).toBe(7.5);
  expect(p.running).toEqual([{ modelId: t.modelB.id, testName: 'B' }]);
  expect(p.activity.map((x: { status: string; testName: string; modelName: string }) => [x.testName, x.modelName, x.status])).toEqual([
    ['A', 'Bêta', 'done'],
    ['B', 'Alpha', 'error'],
    ['A', 'Alpha', 'done'],
  ]);
  expect(p.activity[0]).toMatchObject({ modelId: t.modelB.id, color: '#222222', totalMs: 4000, costUsd: 0.02 });
  expect(p.activity[0].completedAt).toBe(new Date(base + 3000).toISOString());
  expect(p.models).toEqual([
    { id: t.modelA.id, name: 'Alpha', color: '#111111' },
    { id: t.modelB.id, name: 'Bêta', color: '#222222' },
  ]);
  expect(p.matrix).toEqual([
    {
      runTestId: rtA,
      testName: 'A',
      cells: [
        { modelId: t.modelA.id, pending: 1, running: 0, done: 1, failed: 0, unsupported: 0 },
        { modelId: t.modelB.id, pending: 1, running: 0, done: 1, failed: 0, unsupported: 0 },
      ],
    },
    {
      runTestId: rtB,
      testName: 'B',
      cells: [
        { modelId: t.modelA.id, pending: 1, running: 0, done: 0, failed: 1, unsupported: 0 },
        { modelId: t.modelB.id, pending: 1, running: 1, done: 0, failed: 0, unsupported: 0 },
      ],
    },
  ]);

  // Sans mesure, pas d'estimation de la fin.
  const fresh = (await t.post('/api/runs', t.runBody([a], [t.modelA.id]))).json().run;
  const p2 = (await t.get(`/api/runs/${fresh.id}/progress`)).json().progress;
  expect(p2).toMatchObject({ etaSeconds: null, elapsedMs: 0, startedAt: null, activity: [], running: [] });

  expect((await t.get(`/api/runs/${randomUUID()}/progress`)).statusCode).toBe(404);
});

test('Utilisateur : lit séries, progression et résultats ; 403 sur estimate et création', async () => {
  const t = await setup();
  const a = await t.makeTest('A');
  const run = (await t.post('/api/runs', t.runBody([a], [t.modelA.id, t.modelB.id]))).json().run;

  const list = await t.get('/api/runs', t.user);
  expect(list.statusCode).toBe(200);
  expect(list.json().runs).toHaveLength(1);
  expect(list.json().runs[0]).toMatchObject({ id: run.id, modelCount: 2, testCount: 1, counts: { total: 2 } });
  const one = await t.get(`/api/runs/${run.id}`, t.user);
  expect(one.statusCode).toBe(200);
  expect(one.json().run.id).toBe(run.id);
  expect((await t.get(`/api/runs/${run.id}/progress`, t.user)).statusCode).toBe(200);
  const res = await t.get(`/api/runs/${run.id}/results`, t.user);
  expect(res.statusCode).toBe(200);
  expect(res.json().results).toHaveLength(2);
  expect(res.json().results[0]).toMatchObject({
    runTestId: expect.any(String),
    testName: 'A',
    repetition: 1,
    status: 'pending',
    attempts: 0,
    responseText: null,
    tokensEstimated: false,
    scoreStatus: 'awaiting_manual',
    completedAt: null,
  });
  expect((await t.get(`/api/runs/${randomUUID()}`, t.user)).statusCode).toBe(404);

  const body = t.runBody([a], [t.modelA.id]);
  expect((await t.post('/api/runs/estimate', body, t.user)).statusCode).toBe(403);
  expect((await t.post('/api/runs', body, t.user)).statusCode).toBe(403);
  expect(await countOf(t, runs)).toBe(1);
});
