import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { eq, sql } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { errorEvents } from '../src/db/schema/errors.js';
import { jobs } from '../src/db/schema/jobs.js';
import { aiUsage, results } from '../src/db/schema/runs.js';
import { testAttachments } from '../src/db/schema/tests.js';
import { writeValue } from '../src/modules/settings/settings.repo.js';
import { createJobHandlers } from '../src/modules/jobs/handlers.js';
import type { JobHandlers } from '../src/modules/jobs/queue.js';
import { runWorkerOnce } from '../src/modules/jobs/worker.js';
import { resetFakeCallCounters } from '../src/modules/providers/fake.js';
import { createProviderRegistry } from '../src/modules/providers/registry.js';
import type { ProviderAdapter } from '../src/modules/providers/types.js';
import { executeRunSlice } from '../src/modules/runs/engine.js';
import { buildTestApp, loginAs, seedModel, seedProvider, seedUser, testConfig, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const START = new Date('2026-10-17T08:00:00.000Z');
const created: TestApp[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

const fastRegistry = () =>
  createProviderRegistry({
    encryptionKey: testConfig().encryptionKey,
    fakeLlm: true,
    appBaseUrl: 'http://localhost:3000',
    fakeSleep: async () => {},
  });

async function setup() {
  resetFakeCallCounters();
  const t = await buildTestApp({ now: START, fakeLlm: true });
  created.push(t);
  await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin' });
  await seedUser(t.db, { email: 'user@acme.fr', role: 'user' });
  const admin = await loginAs(t.app, 'admin@acme.fr', PW);
  const user = await loginAs(t.app, 'user@acme.fr', PW);
  const call = (method: 'GET' | 'POST', url: string, s: typeof admin, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const provider = await seedProvider(t.db, { maxConcurrency: 8 });
  const model = await seedModel(t.db, {
    providerId: provider.id,
    apiModelId: 'fake-modele-0',
    displayName: 'Modèle 0',
    inputPricePerM: 1,
    outputPricePerM: 10,
  });
  const createTest = async (prompt: string) => {
    const res = await call('POST', '/api/tests', admin, {
      name: 'Test',
      category: 'Culture',
      userPrompt: prompt,
      scoringMethod: 'manual',
      scoringConfig: {},
    });
    expect(res.statusCode).toBe(201);
    return res.json().test.id as string;
  };
  const quickHandlers = (): JobHandlers =>
    createJobHandlers({
      db: t.db,
      mailer: t.mailer,
      config: { appBaseUrl: 'http://localhost:3000', dataDir: tmpdir() },
      registry: fastRegistry(),
      clock: () => t.clock.now(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
  const runFast = (handlers = quickHandlers()) =>
    runWorkerOnce({ db: t.db, clock: () => t.clock.now(), workerId: 'rapide', types: ['quick_try'] }, handlers);
  return {
    ...t,
    admin,
    user,
    provider,
    model,
    createTest,
    runFast,
    get: (url: string, s = admin) => call('GET', url, s),
    post: (url: string, payload: unknown, s = admin) => call('POST', url, s, payload),
  };
}

test('essai rapide : 202 puis done avec texte, métriques et coût ; ai_usage quick_try ; aucun résultat de série', async () => {
  const t = await setup();
  const testId = await t.createTest('Quelle est la capitale de la France ?');
  const started = await t.post('/api/tests/try', { testId, modelId: t.model.id });
  expect(started.statusCode).toBe(202);
  const { jobId } = started.json() as { jobId: string };

  const queued = await t.get(`/api/tests/try/${jobId}`);
  expect(queued.statusCode).toBe(200);
  expect(queued.json()).toEqual({ status: 'queued' });

  expect(await t.runFast()).toBe(true);
  const res = await t.get(`/api/tests/try/${jobId}`);
  const body = res.json();
  expect(body.status).toBe('done');
  expect(body.outcome).toMatchObject({ status: 'done', modelName: 'Modèle 0', errorCode: null });
  expect(body.outcome.text.length).toBeGreaterThan(0);
  expect(body.outcome.outputTokens).toBeGreaterThan(0);
  expect(body.outcome.totalMs).toBeGreaterThanOrEqual(0);
  expect(body.outcome.costUsd).toBeGreaterThan(0);

  const usage = await t.db.select().from(aiUsage);
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ origin: 'quick_try', runId: null, modelId: t.model.id });
  expect(usage[0]!.costUsd).toBeCloseTo(body.outcome.costUsd, 5);
  expect(await t.db.select().from(results)).toHaveLength(0);

  const [job] = await t.db.select().from(jobs).where(eq(jobs.id, jobId));
  expect(job).toMatchObject({ type: 'quick_try', maxAttempts: 1, payload: { testId, modelId: t.model.id } });
  expect(Object.keys(job!.payload as object).sort()).toEqual(['modelId', 'requestedBy', 'testId']);
});

test('ai_usage impossible à écrire : essai done avec son issue, erreur journalisée', async () => {
  const t = await setup();
  const testId = await t.createTest('Bonjour');
  await t.db.execute(
    sql.raw(`CREATE TRIGGER fail_usage BEFORE INSERT ON ai_usage FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'écriture refusée'`),
  );
  const { jobId } = (await t.post('/api/tests/try', { testId, modelId: t.model.id })).json() as { jobId: string };
  expect(await t.runFast()).toBe(true);
  const body = (await t.get(`/api/tests/try/${jobId}`)).json();
  expect(body.status).toBe('done');
  expect(body.outcome).toMatchObject({ status: 'done', modelName: 'Modèle 0' });
  expect(body.outcome.text.length).toBeGreaterThan(0);
  expect(await t.db.select().from(aiUsage)).toHaveLength(0);
  const events = await t.db.select().from(errorEvents);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ source: 'job', origin: 'quick_try', targetType: 'job', targetId: jobId });
});

test('erreur du fournisseur : status done avec outcome.status error et message masqué', async () => {
  const t = await setup();
  const testId = await t.createTest('Panne [[fake:500]]');
  const { jobId } = (await t.post('/api/tests/try', { testId, modelId: t.model.id })).json() as { jobId: string };
  await t.runFast();
  const body = (await t.get(`/api/tests/try/${jobId}`)).json();
  expect(body.status).toBe('done');
  expect(body.outcome).toMatchObject({ status: 'error', errorCode: 'provider_unavailable', costUsd: null });
  expect(body.outcome.errorMessage).toEqual(expect.any(String));
  expect(await t.db.select().from(aiUsage)).toHaveLength(0);
});

test('la voie rapide traite l’essai pendant qu’une tranche de série occupe le worker principal', async () => {
  const t = await setup();
  // Série d'un test : la tranche reste bloquée dans l'appel du modèle.
  const runTestId = await t.createTest('Longue');
  const run = await t.post('/api/runs', { name: 'Série', testIds: [runTestId], modelIds: [t.model.id], concurrency: 1 });
  expect(run.statusCode).toBe(201);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const callStarted = new Promise<void>((r) => (started = r));
  const slow: ProviderAdapter = {
    async *generate() {
      started();
      await gate;
      yield { type: 'text', delta: 'ok' };
      yield { type: 'usage', inputTokens: 5, outputTokens: 5 };
      yield { type: 'finish', reason: 'stop' };
    },
    listModels: async () => [],
  };
  const mainHandlers: JobHandlers = {
    run_execute: (job, ctx) =>
      executeRunSlice({ db: t.db, registry: { adapterFor: () => slow }, config: { dataDir: tmpdir() }, sleep: async () => {} }, job, ctx),
  };
  const main = runWorkerOnce({ db: t.db, clock: () => t.clock.now(), workerId: 'principal' }, mainHandlers);
  await callStarted;

  const tryTestId = await t.createTest('Rapide');
  const { jobId } = (await t.post('/api/tests/try', { testId: tryTestId, modelId: t.model.id })).json() as { jobId: string };
  // Le worker rapide ne prend que `quick_try` ; la tranche de série est toujours en cours.
  expect(await t.runFast()).toBe(true);
  expect((await t.get(`/api/tests/try/${jobId}`)).json().status).toBe('done');
  const [slice] = await t.db.select().from(jobs).where(eq(jobs.type, 'run_execute'));
  expect(slice!.status).toBe('running');

  release();
  expect(await main).toBe(true);
});

test('GET d’un identifiant de tâche d’un autre type → 404 ; Utilisateur → 403', async () => {
  const t = await setup();
  const otherId = randomUUID();
  await t.db.insert(jobs).values({ id: otherId, type: 'errors_purge', payload: {}, runAfter: START, maxAttempts: 1, createdAt: START });
  expect((await t.get(`/api/tests/try/${otherId}`)).statusCode).toBe(404);
  expect((await t.get(`/api/tests/try/${randomUUID()}`)).statusCode).toBe(404);

  const testId = await t.createTest('Prompt');
  const { jobId } = (await t.post('/api/tests/try', { testId, modelId: t.model.id })).json() as { jobId: string };
  expect((await t.get(`/api/tests/try/${jobId}`, t.user)).statusCode).toBe(403);
  expect((await t.post('/api/tests/try', { testId, modelId: t.model.id }, t.user)).statusCode).toBe(403);
});

test('GET répond immédiatement (pas d’attente du résultat)', async () => {
  const t = await setup();
  const testId = await t.createTest('Prompt');
  const { jobId } = (await t.post('/api/tests/try', { testId, modelId: t.model.id })).json() as { jobId: string };
  const start = Date.now();
  const res = await t.get(`/api/tests/try/${jobId}`);
  expect(Date.now() - start).toBeLessThan(200);
  expect(res.json()).toEqual({ status: 'queued' });
});

test('modèle indisponible → 409 ; pièce jointe non gérée par le modèle → 400 ; test ou modèle inconnu', async () => {
  const t = await setup();
  const testId = await t.createTest('Prompt');
  const off = await seedModel(t.db, { providerId: t.provider.id, displayName: 'Éteint', enabled: false });
  const refused = await t.post('/api/tests/try', { testId, modelId: off.id });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.code).toBe('model_unavailable');
  expect((await t.post('/api/tests/try', { testId, modelId: randomUUID() })).json().error.code).toBe('model_unavailable');
  expect((await t.post('/api/tests/try', { testId: randomUUID(), modelId: t.model.id })).statusCode).toBe(400);

  await t.db.insert(testAttachments).values({
    id: randomUUID(),
    testId,
    originalName: 'a.png',
    mime: 'image/png',
    size: 10,
    storagePath: `${testId}/x`,
    sha256: 'a'.repeat(64),
  });
  const unsupported = await t.post('/api/tests/try', { testId, modelId: t.model.id }); // modèle sans vision
  expect(unsupported.statusCode).toBe(400);
  expect(unsupported.json().error.code).toBe('unsupported_attachment');
  expect(await t.db.select().from(jobs)).toHaveLength(0);
});

const DEFAULT_JUDGE_KEY = 'scoring.default_judge_model_id';

async function tryTest(t: Awaited<ReturnType<typeof setup>>, payload: { scoringMethod: string; scoringConfig: unknown; userPrompt: string }) {
  const res = await t.post('/api/tests', { name: 'Noté', category: 'Culture', ...payload });
  expect(res.statusCode).toBe(201);
  const testId = res.json().test.id as string;
  const { jobId } = (await t.post('/api/tests/try', { testId, modelId: t.model.id })).json() as { jobId: string };
  expect(await t.runFast()).toBe(true);
  return (await t.get(`/api/tests/try/${jobId}`)).json();
}

test('essai rapide d’un test expected : note et justification dans l’issue', async () => {
  const t = await setup();
  const body = await tryTest(t, {
    scoringMethod: 'expected',
    scoringConfig: { mode: 'contains', items: ['zzz-introuvable'], ignoreCase: true },
    userPrompt: 'Dis quelque chose',
  });
  expect(body.status).toBe('done');
  expect(body.outcome.score).toEqual({ method: 'expected', score: 0, rationale: '0 élément trouvé sur 1' });
  expect((await t.db.select().from(aiUsage)).map((u) => u.origin)).toEqual(['quick_try']);
});

test('essai rapide d’un test manuel : score nul', async () => {
  const t = await setup();
  const body = await tryTest(t, { scoringMethod: 'manual', scoringConfig: {}, userPrompt: 'Bonjour' });
  expect(body.outcome.score).toBeNull();
});

test('essai rapide d’un test judge : appel du juge par défaut, coût ai_usage judge, note affichée', async () => {
  const t = await setup();
  const judge = await seedModel(t.db, {
    providerId: t.provider.id,
    apiModelId: 'fake-juge-0',
    displayName: 'Juge 0',
    inputPricePerM: 2,
    outputPricePerM: 20,
  });
  await writeValue(t.db, DEFAULT_JUDGE_KEY, judge.id);
  const body = await tryTest(t, {
    scoringMethod: 'judge',
    scoringConfig: { criteria: 'Clarté' },
    userPrompt: 'Explique [[fake:judge={"score": 8, "rationale": "Clair et complet"}]]',
  });
  expect(body.status).toBe('done');
  expect(body.outcome.score).toMatchObject({ method: 'judge', score: 8, rationale: 'Clair et complet', judgeModelName: 'Juge 0' });
  expect(body.outcome.score.judgeCostUsd).toBeGreaterThan(0);
  const usage = await t.db.select().from(aiUsage);
  expect(usage.map((u) => u.origin).sort()).toEqual(['judge', 'quick_try']);
  const judged = usage.find((u) => u.origin === 'judge')!;
  expect(judged).toMatchObject({ runId: null, modelId: judge.id });
  expect(judged.costUsd).toBeCloseTo(body.outcome.score.judgeCostUsd, 5);
  expect(await t.db.select().from(results)).toHaveLength(0);
});

test('juge : réponse illisible, un second appel puis score nul ; les deux appels sont facturés', async () => {
  const t = await setup();
  const judge = await seedModel(t.db, { providerId: t.provider.id, apiModelId: 'fake-juge-0', displayName: 'Juge 0' });
  await writeValue(t.db, DEFAULT_JUDGE_KEY, judge.id);
  const body = await tryTest(t, {
    scoringMethod: 'judge',
    scoringConfig: { criteria: 'Clarté' },
    userPrompt: 'Explique [[fake:judge=pas du json]]',
  });
  expect(body.status).toBe('done');
  expect(body.outcome.score).toMatchObject({ method: 'judge', score: null, rationale: 'Réponse du juge illisible', judgeModelName: 'Juge 0' });
  expect((await t.db.select().from(aiUsage)).filter((u) => u.origin === 'judge')).toHaveLength(2);
});

test('juge : écriture de ai_usage impossible, note gardée et erreur journalisée', async () => {
  const t = await setup();
  const judge = await seedModel(t.db, { providerId: t.provider.id, apiModelId: 'fake-juge-0', displayName: 'Juge 0' });
  await writeValue(t.db, DEFAULT_JUDGE_KEY, judge.id);
  await t.db.execute(
    sql.raw(`CREATE TRIGGER fail_usage BEFORE INSERT ON ai_usage FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'écriture refusée'`),
  );
  const body = await tryTest(t, {
    scoringMethod: 'judge',
    scoringConfig: { criteria: 'Clarté' },
    userPrompt: 'Explique [[fake:judge={"score": 6, "rationale": "Moyen"}]]',
  });
  expect(body.status).toBe('done');
  expect(body.outcome.score).toMatchObject({ method: 'judge', score: 6 });
  expect((await t.db.select().from(errorEvents)).length).toBeGreaterThanOrEqual(1);
});

test('sans juge par défaut : score null et message', async () => {
  const t = await setup();
  const body = await tryTest(t, {
    scoringMethod: 'judge',
    scoringConfig: { criteria: 'Clarté' },
    userPrompt: 'Explique',
  });
  expect(body.status).toBe('done');
  expect(body.outcome.score).toEqual({ method: 'judge', score: null, rationale: 'Aucun juge par défaut disponible' });
  expect((await t.db.select().from(aiUsage)).map((u) => u.origin)).toEqual(['quick_try']);
});

test('modèle évalué en erreur : aucune note', async () => {
  const t = await setup();
  const body = await tryTest(t, {
    scoringMethod: 'expected',
    scoringConfig: { mode: 'contains', items: ['x'], ignoreCase: true },
    userPrompt: 'Panne [[fake:500]]',
  });
  expect(body.outcome.status).toBe('error');
  expect(body.outcome.score).toBeNull();
});
