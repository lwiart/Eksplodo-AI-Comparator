import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { afterEach, expect, test, vi } from 'vitest';
import type { Db } from '../src/db/client.js';
import { auditLog } from '../src/db/schema/core.js';
import { errorEvents } from '../src/db/schema/errors.js';
import { jobs } from '../src/db/schema/jobs.js';
import { results, runTests, runs } from '../src/db/schema/runs.js';
import { enqueue, type JobHandlers } from '../src/modules/jobs/queue.js';
import { startSchedulerLoop } from '../src/modules/jobs/scheduler-loop.js';
import type { ScheduleEntry } from '../src/modules/jobs/scheduler.js';
import { runWorkerOnce } from '../src/modules/jobs/worker.js';
import { httpError } from '../src/modules/providers/errors.js';
import { resetFakeCallCounters } from '../src/modules/providers/fake.js';
import { createProviderRegistry, type ProviderLike } from '../src/modules/providers/registry.js';
import type { GenerateEvent, ProviderAdapter } from '../src/modules/providers/types.js';
import { executeRunSlice, type EngineDeps } from '../src/modules/runs/engine.js';
import { recoverRuns } from '../src/modules/runs/run-job.js';
import { buildTestApp, loginAs, seedModel, seedProvider, seedUser, testConfig, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const START = new Date('2026-10-17T08:00:00.000Z');
const created: TestApp[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

type Wrap = (inner: ProviderAdapter, provider: ProviderLike) => ProviderAdapter;

/** Registre du faux fournisseur, sans attente réelle ; chaque adaptateur peut être enveloppé. */
function registryOf(wrap: Wrap = (inner) => inner): EngineDeps['registry'] {
  const base = createProviderRegistry({
    encryptionKey: testConfig().encryptionKey,
    fakeLlm: true,
    appBaseUrl: 'http://localhost:3000',
    fakeSleep: async () => {},
  });
  return { adapterFor: (p: ProviderLike) => wrap(base.adapterFor(p), p) };
}

const failing = (err: unknown): AsyncIterable<GenerateEvent> =>
  (async function* () {
    throw err;
  })();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function until(cond: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition non atteinte');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Application de test (faux fournisseur : modèles disponibles sans clé), un Admin et un Utilisateur connectés, des
 * modèles à 0 $ en entrée et 10 $ en sortie par million de tokens : coût maximal d'un appel (1 000 tokens) = 0,01 $.
 */
async function setup(opts: { models?: number; schedules?: ScheduleEntry[] } = {}) {
  resetFakeCallCounters();
  const t = await buildTestApp({ now: START, fakeLlm: true, schedules: opts.schedules ?? [] });
  created.push(t);
  await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin' });
  await seedUser(t.db, { email: 'user@acme.fr', role: 'user' });
  const admin = await loginAs(t.app, 'admin@acme.fr', PW);
  const user = await loginAs(t.app, 'user@acme.fr', PW);
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, s: typeof admin, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const api = {
    get: (url: string, s = admin) => call('GET', url, s),
    post: (url: string, payload: unknown = {}, s = admin) => call('POST', url, s, payload),
    patch: (url: string, payload: unknown, s = admin) => call('PATCH', url, s, payload),
  };
  const provider = await seedProvider(t.db, { maxConcurrency: 8 });
  const modelIds: string[] = [];
  for (let i = 0; i < (opts.models ?? 2); i++) {
    const m = await seedModel(t.db, {
      providerId: provider.id,
      apiModelId: `fake-modele-${i}`, // profil par défaut du faux fournisseur
      displayName: `Modèle ${i}`,
      inputPricePerM: 0,
      outputPricePerM: 10,
    });
    modelIds.push(m.id);
  }

  async function createRun(prompts: string[], extra: Record<string, unknown> = {}): Promise<string> {
    const testIds: string[] = [];
    for (const [i, prompt] of prompts.entries()) {
      const res = await api.post('/api/tests', { name: `Test ${i}`, category: 'Culture', userPrompt: prompt, scoringMethod: 'manual', scoringConfig: {} });
      expect(res.statusCode).toBe(201);
      testIds.push(res.json().test.id as string);
    }
    const res = await api.post('/api/runs', { name: 'Série', testIds, modelIds: extra.modelIds ?? modelIds, concurrency: 4, ...extra });
    expect(res.statusCode).toBe(201);
    return res.json().run.id as string;
  }

  const clock = () => t.clock.now();
  const engineDeps = (registry = registryOf()): EngineDeps => ({ db: t.db, registry, config: { dataDir: tmpdir() }, sleep: async () => {} });
  const handlersFor = (deps: EngineDeps): JobHandlers => ({ run_execute: (job, ctx) => executeRunSlice(deps, job, ctx) });
  const runOnce = (registry?: EngineDeps['registry'], workerId = 'w1') =>
    runWorkerOnce({ db: t.db, clock, workerId }, handlersFor(engineDeps(registry)));

  /** Exécute les tâches prêtes jusqu'à épuisement ; une tâche en échec fait échouer le test. */
  async function drain(registry?: EngineDeps['registry']): Promise<void> {
    let n = 0;
    while (await runOnce(registry)) if (++n > 50) throw new Error('trop de tranches');
    const failed = await t.db.select().from(jobs).where(sql`${jobs.error} IS NOT NULL`);
    if (failed.length > 0) throw new Error(`tâche en échec : ${failed[0]!.error}`);
  }

  const runRow = async (runId: string) => (await t.db.select().from(runs).where(eq(runs.id, runId)))[0]!;
  const resultRows = (runId: string) => t.db.select().from(results).where(eq(results.runId, runId));
  const activeJobs = (runId: string) =>
    t.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, 'run_execute'),
          inArray(jobs.status, ['queued', 'running']),
          sql`JSON_VALUE(${jobs.payload}, '$.runId') = ${runId}`,
        ),
      );
  const auditActions = async () => (await t.db.select({ action: auditLog.action }).from(auditLog)).map((r) => r.action);

  return { ...t, admin, user, ...api, provider, modelIds, createRun, runOnce, drain, runRow, resultRows, activeJobs, auditActions };
}

/** Adaptateur retenu jusqu'à l'ouverture de `gate`, puis réponse de 1 000 tokens de sortie (coût = 0,01 $). */
function gatedRegistry(gate: Promise<void>, onStart: (n: number) => void, calls: string[] = []) {
  let started = 0;
  return registryOf(() => ({
    async *generate(req) {
      calls.push(`${req.model}|${req.prompt}`);
      onStart(++started);
      await gate;
      yield { type: 'text', delta: 'ok' };
      yield { type: 'usage', inputTokens: 5, outputTokens: 1000 };
      yield { type: 'finish', reason: 'stop' };
    },
    listModels: async () => [],
  }));
}

test('pause : les appels en vol se terminent, aucun nouveau lancement, puis reprise jusqu’au bout', async () => {
  const t = await setup();
  const runId = await t.createRun(['Un', 'Deux'], { concurrency: 2 });
  const gate = deferred();
  const twoStarted = deferred();
  const calls: string[] = [];
  const registry = gatedRegistry(gate.promise, (n) => n === 2 && twoStarted.resolve(), calls);

  const worker = t.runOnce(registry);
  await twoStarted.promise;
  const paused = await t.post(`/api/runs/${runId}/pause`);
  expect(paused.statusCode).toBe(200);
  expect(paused.json().run).toMatchObject({ status: 'paused', pauseReason: 'user' });
  gate.resolve();
  expect(await worker).toBe(true);

  // Les deux appels en vol sont enregistrés ; la tranche se retire sans relancer (statut paused gardé).
  expect(calls).toHaveLength(2);
  const rows = await t.resultRows(runId);
  expect(rows.filter((r) => r.status === 'done')).toHaveLength(2);
  expect(rows.filter((r) => r.status === 'pending')).toHaveLength(2);
  expect(await t.runRow(runId)).toMatchObject({ status: 'paused', pauseReason: 'user', activeJobId: null });
  expect(await t.activeJobs(runId)).toHaveLength(0);
  expect((await t.post(`/api/runs/${runId}/pause`)).json().error.code).toBe('run_not_active');

  const resumed = await t.post(`/api/runs/${runId}/resume`);
  expect(resumed.statusCode).toBe(200);
  expect(resumed.json().run).toMatchObject({ status: 'queued', pauseReason: null });
  expect(await t.activeJobs(runId)).toHaveLength(1);
  await t.drain(registry);
  expect(calls).toHaveLength(4);
  expect((await t.resultRows(runId)).every((r) => r.status === 'done' && r.attempts === 1)).toBe(true);
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed', activeJobId: null });
  const again = await t.post(`/api/runs/${runId}/resume`);
  expect(again.statusCode).toBe(409);
  expect(again.json().error.code).toBe('run_not_paused');
  expect(await t.auditActions()).toEqual(expect.arrayContaining(['run_created', 'run_paused', 'run_resumed']));
});

test('plafond : jamais dépassé par les appels lancés, pause budget ; relever puis reprendre termine la série', async () => {
  const t = await setup();
  // Plafond = coût maximal de 3 appels (3 × 0,01 $) ; concurrence 4, 8 résultats.
  const budget = 0.03;
  const runId = await t.createRun(['Un', 'Deux', 'Trois', 'Quatre'], { concurrency: 4, budgetUsd: budget });
  const gate = deferred();
  let started = 0;
  const registry = gatedRegistry(gate.promise, (n) => void (started = n));

  const worker = t.runOnce(registry);
  // Trois appels réservent tout le plafond : le quatrième attend leur fin (pas de pause tant qu'un appel est en vol).
  await until(() => started === 3);
  await new Promise((r) => setTimeout(r, 50));
  expect(started).toBe(3);
  expect((await t.runRow(runId)).status).toBe('running');
  // Coût réel = coût maximal : une fois les trois appels terminés, le quatrième ne tient plus → pause budget.
  gate.resolve();
  expect(await worker).toBe(true);
  expect(started).toBe(3);

  const run = await t.runRow(runId);
  expect(run.modelsCostUsd).toBeLessThanOrEqual(budget);
  expect(run.modelsCostUsd).toBeCloseTo(0.03, 6);
  expect(run).toMatchObject({ status: 'paused', pauseReason: 'budget', activeJobId: null });
  const rows = await t.resultRows(runId);
  expect(rows.filter((r) => r.status === 'done')).toHaveLength(3);
  expect(rows.filter((r) => r.status === 'pending')).toHaveLength(5);

  const patched = await t.patch(`/api/runs/${runId}`, { budgetUsd: 1 });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().run).toMatchObject({ budgetUsd: 1, status: 'paused' });
  expect((await t.post(`/api/runs/${runId}/resume`)).statusCode).toBe(200);
  await t.drain(registry);
  const done = await t.runRow(runId);
  expect(done).toMatchObject({ status: 'completed', pauseReason: null });
  expect(done.modelsCostUsd).toBeCloseTo(0.08, 6);
  expect(await t.auditActions()).toContain('run_updated');
});

test('plafond : appels réels peu coûteux, coût maximal élevé → la série va plus loin sans dépasser le plafond', async () => {
  const t = await setup({ models: 4 });
  // Coût maximal d'un appel : 300 tokens × 10 $/M = 0,003 $ ; coût réel : 100 tokens = 0,001 $ ; plafond = 10 appels réels.
  const budget = 0.01;
  const testIds: string[] = [];
  for (const [i, prompt] of ['Un', 'Deux', 'Trois'].entries()) {
    const res = await t.post('/api/tests', { name: `Test ${i}`, category: 'Culture', userPrompt: prompt, maxTokens: 300, scoringMethod: 'manual', scoringConfig: {} });
    testIds.push(res.json().test.id as string);
  }
  const created = await t.post('/api/runs', { name: 'Série', testIds, modelIds: t.modelIds, concurrency: 4, budgetUsd: budget });
  expect(created.statusCode).toBe(201);
  const runId = created.json().run.id as string;
  let active = 0;
  let maxActive = 0;
  const registry = registryOf(() => ({
    async *generate() {
      maxActive = Math.max(maxActive, ++active);
      try {
        await new Promise((r) => setTimeout(r, 20));
        yield { type: 'text', delta: 'ok' };
        yield { type: 'usage', inputTokens: 5, outputTokens: 100 };
        yield { type: 'finish', reason: 'stop' };
      } finally {
        active--;
      }
    },
    listModels: async () => [],
  }));
  await t.drain(registry);

  // Ancienne règle : 3 appels (3 × 0,003 $ réservés) puis pause. Nouvelle règle : la pause n'arrive qu'une fois les appels
  // en vol terminés, quand dépense réelle + coût maximal du suivant dépasse le plafond (8 × 0,001 + 0,003 > 0,01).
  const run = await t.runRow(runId);
  expect(run).toMatchObject({ status: 'paused', pauseReason: 'budget', activeJobId: null });
  expect(run.modelsCostUsd).toBeLessThanOrEqual(budget);
  expect(run.modelsCostUsd).toBeCloseTo(0.008, 6);
  const rows = await t.resultRows(runId);
  expect(rows.filter((r) => r.status === 'done')).toHaveLength(8);
  expect(rows.filter((r) => r.status === 'pending')).toHaveLength(4);
  expect(maxActive).toBeGreaterThan(1);
  expect(maxActive).toBeLessThanOrEqual(3); // jamais plus d'appels en vol que le plafond n'en couvre
  // Minimum utile pour reprendre : 0,008 + 0,003 = 0,011 $.
  expect((await t.get(`/api/runs/${runId}/progress`)).json().progress.nextCallMaxCostUsd).toBeCloseTo(0.003, 6);
  expect((await t.patch(`/api/runs/${runId}`, { budgetUsd: 0.0109 })).statusCode).toBe(200);
  expect((await t.post(`/api/runs/${runId}/resume`)).statusCode).toBe(409);
  expect((await t.patch(`/api/runs/${runId}`, { budgetUsd: 0.011 })).statusCode).toBe(200);
  expect((await t.post(`/api/runs/${runId}/resume`)).statusCode).toBe(200);
});

test('plafond : un appel qui se termine pendant la lecture de la série n’est jamais oublié', async () => {
  const t = await setup();
  // Coût maximal = coût réel = 0,01 $ ; plafond 0,015 $ : un seul appel tient, le second ne doit jamais partir.
  const budget = 0.015;
  const runId = await t.createRun(['Un'], { concurrency: 2, budgetUsd: budget });
  const gate = deferred();
  let started = 0;
  const registry = gatedRegistry(gate.promise, (n) => void (started = n));
  const firstResultDone = async () => (await t.resultRows(runId)).some((r) => r.status === 'done');

  // Lecture de la série avant chaque lancement : la seconde (lancement du second appel) est faite, puis le premier appel
  // se termine (coût validé, réservation rendue) avant que la lecture ne rende sa ligne, d'avant ce coût.
  let budgetReads = 0;
  const instrumented = new Proxy(t.db, {
    get(target, prop, receiver) {
      if (prop === 'select') {
        return (fields?: Record<string, unknown>) => {
          const builder = target.select(fields as never);
          if (!fields || !('budgetUsd' in fields) || ++budgetReads !== 2) return builder;
          return {
            from: (table: typeof runs) => ({
              where: (cond: SQL | undefined) => ({
                then: (resolve: (rows: unknown) => unknown, reject: (err: unknown) => unknown) =>
                  (async () => {
                    const rows = await builder.from(table).where(cond);
                    gate.resolve();
                    await until(firstResultDone);
                    await new Promise((r) => setTimeout(r, 50)); // fin de la tâche de l'appel (réservation rendue)
                    return rows;
                  })().then(resolve, reject),
              }),
            }),
          };
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Db;
  const deps: EngineDeps = { db: instrumented, registry, config: { dataDir: tmpdir() }, sleep: async () => {} };
  const handlers: JobHandlers = { run_execute: (job, ctx) => executeRunSlice(deps, job, ctx) };
  expect(await runWorkerOnce({ db: t.db, clock: () => t.clock.now(), workerId: 'w1' }, handlers)).toBe(true);

  expect(budgetReads).toBeGreaterThanOrEqual(2);
  expect(started).toBe(1);
  const run = await t.runRow(runId);
  expect(run).toMatchObject({ status: 'paused', pauseReason: 'budget' });
  expect(run.modelsCostUsd).toBeLessThanOrEqual(budget);
  expect(run.modelsCostUsd).toBeCloseTo(0.01, 6);
});

test('plafond : nouvelle tentative rendue à la file pendant un contrôle de lancement → aucun double lancement, plafond tenu', async () => {
  const t = await setup();
  // 6 résultats (A … F : 3 tests × 2 modèles), concurrence 8, coût maximal = coût réel = 0,01 $, plafond 0,03 $.
  const budget = 0.03;
  const runId = await t.createRun(['Un', 'Deux', 'Trois'], { concurrency: 8, budgetUsd: budget });
  const gate = deferred();
  const calls: string[] = [];
  let first = true;
  const registry = registryOf(() => ({
    async *generate(req) {
      calls.push(`${req.model}|${req.prompt}`);
      if (first) {
        first = false;
        throw httpError(503, 'Indisponible', {}, []); // A : échec à rejouer
      }
      await gate.promise;
      yield { type: 'text', delta: 'ok' };
      yield { type: 'usage', inputTokens: 5, outputTokens: 1000 };
      yield { type: 'finish', reason: 'stop' };
    },
    listModels: async () => [],
  }));
  const resultA = async () => (await t.resultRows(runId)).find((r) => r.attempts === 1 && r.status === 'pending' && r.errorCode === null);

  // Le contrôle de B (2ᵉ lecture du plafond) lit la série ; pendant qu'il attend, la nouvelle tentative de A ne tient plus
  // (plafond abaissé un instant) et A est rendu en tête de la file, puis le plafond est rétabli.
  const hookReached = deferred();
  let budgetReads = 0;
  const instrumented = new Proxy(t.db, {
    get(target, prop, receiver) {
      if (prop === 'select') {
        return (fields?: Record<string, unknown>) => {
          const builder = target.select(fields as never);
          if (!fields || !('budgetUsd' in fields) || ++budgetReads !== 2) return builder;
          return {
            from: (table: typeof runs) => ({
              where: (cond: SQL | undefined) => ({
                then: (resolve: (rows: unknown) => unknown, reject: (err: unknown) => unknown) =>
                  (async () => {
                    const rows = await builder.from(table).where(cond);
                    hookReached.resolve();
                    await until(async () => (await resultA()) !== undefined);
                    await new Promise((r) => setTimeout(r, 50)); // A rendu à la file de la tranche
                    await t.db.update(runs).set({ budgetUsd: budget }).where(eq(runs.id, runId));
                    return rows;
                  })().then(resolve, reject),
              }),
            }),
          };
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Db;
  const sleep = async () => {
    await hookReached.promise;
    await t.db.update(runs).set({ budgetUsd: 0.0001 }).where(eq(runs.id, runId));
  };
  const deps: EngineDeps = { db: instrumented, registry, config: { dataDir: tmpdir() }, sleep };
  const handlers: JobHandlers = { run_execute: (job, ctx) => executeRunSlice(deps, job, ctx) };
  const worker = runWorkerOnce({ db: t.db, clock: () => t.clock.now(), workerId: 'w1' }, handlers);
  // Lancements stabilisés (plus aucun nouvel appel), puis réponses.
  await until(() => budgetReads >= 2);
  let seen = -1;
  await until(async () => {
    const stable = calls.length === seen;
    seen = calls.length;
    await new Promise((r) => setTimeout(r, 150));
    return stable;
  });
  gate.resolve();
  expect(await worker).toBe(true);

  const run = await t.runRow(runId);
  expect(run.modelsCostUsd).toBeLessThanOrEqual(budget);
  expect(run).toMatchObject({ status: 'paused', pauseReason: 'budget' });
  // A : un échec puis sa nouvelle tentative ; aucun autre résultat appelé deux fois.
  const perResult = new Map<string, number>();
  for (const c of calls) perResult.set(c, (perResult.get(c) ?? 0) + 1);
  expect([...perResult.values()].sort()).toEqual([1, 1, 2]);
  const rows = await t.resultRows(runId);
  expect(rows.filter((r) => r.status === 'done')).toHaveLength(3);
  expect(rows.filter((r) => r.status === 'pending')).toHaveLength(3);
  expect(rows.filter((r) => r.status === 'running')).toHaveLength(0);
});

test('plafond : la tête de file ne tient plus, un appel moins cher tient → il part avant la pause', async () => {
  const t = await setup({ models: 1 });
  // « Long » : 1 000 tokens au plus (0,01 $) ; « Court » : 300 tokens au plus (0,003 $) ; coût réel 100 tokens (0,001 $).
  const testIds: string[] = [];
  for (const [name, maxTokens] of [['Long', 1000], ['Court', 300]] as const) {
    const res = await t.post('/api/tests', { name, category: 'Culture', userPrompt: name, maxTokens, scoringMethod: 'manual', scoringConfig: {} });
    testIds.push(res.json().test.id as string);
  }
  const created = await t.post('/api/runs', { name: 'Série', testIds, modelIds: t.modelIds, concurrency: 1, budgetUsd: 0.005 });
  const runId = created.json().run.id as string;
  const calls: string[] = [];
  const registry = registryOf(() => ({
    async *generate(req) {
      calls.push(req.prompt);
      yield { type: 'text', delta: 'ok' };
      yield { type: 'usage', inputTokens: 5, outputTokens: 100 };
      yield { type: 'finish', reason: 'stop' };
    },
    listModels: async () => [],
  }));
  await t.drain(registry);
  expect(calls).toEqual(['Court']);
  const rows = await t.resultRows(runId);
  expect(rows.find((r) => r.status === 'done')).toBeDefined();
  expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
  const run = await t.runRow(runId);
  expect(run).toMatchObject({ status: 'paused', pauseReason: 'budget' });
  expect(run.modelsCostUsd).toBeCloseTo(0.001, 6);
});

test('reprendre sans relever le plafond → 409 budget_exceeded', async () => {
  const t = await setup();
  const runId = await t.createRun(['Un', 'Deux'], { budgetUsd: 0.03 });
  // Prochain appel le moins cher : « Deux », 500 tokens de sortie au plus (0,005 $).
  const [, second] = await t.db.select().from(runTests).where(eq(runTests.runId, runId)).orderBy(runTests.position);
  await t.db.update(runTests).set({ snapshot: { ...second!.snapshot, maxTokens: 500 } }).where(eq(runTests.id, second!.id));
  // Dépense (modèles + juge) égale au plafond ; la tranche s'est retirée.
  await t.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, (await t.runRow(runId)).activeJobId!));
  await t.db
    .update(runs)
    .set({ status: 'paused', pauseReason: 'budget', modelsCostUsd: 0.02, judgeCostUsd: 0.01, activeJobId: null })
    .where(eq(runs.id, runId));
  const refused = await t.post(`/api/runs/${runId}/resume`);
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.code).toBe('budget_exceeded');
  expect(await t.runRow(runId)).toMatchObject({ status: 'paused', pauseReason: 'budget' });
  expect(await t.activeJobs(runId)).toHaveLength(0);
  // Minimum utile exposé par l'avancement : coût maximal du prochain appel, le moins cher des appels en attente.
  expect((await t.get(`/api/runs/${runId}/progress`)).json().progress.nextCallMaxCostUsd).toBeCloseTo(0.005, 6);

  // Plafond relevé au-dessus de la dépense mais sous dépense + coût maximal du prochain appel : toujours refusé.
  expect((await t.patch(`/api/runs/${runId}`, { budgetUsd: 0.0349 })).statusCode).toBe(200);
  expect((await t.post(`/api/runs/${runId}/resume`)).json().error.code).toBe('budget_exceeded');

  // Plafond = dépense + coût maximal du prochain appel : le moteur pourrait le lancer, reprise acceptée.
  expect((await t.patch(`/api/runs/${runId}`, { budgetUsd: 0.035 })).statusCode).toBe(200);
  const ok = await t.post(`/api/runs/${runId}/resume`);
  expect(ok.statusCode).toBe(200);
  expect(ok.json().run.status).toBe('queued');
  expect(await t.activeJobs(runId)).toHaveLength(1);

  // Sans plafond : reprise toujours acceptée.
  await t.db.update(runs).set({ status: 'paused', pauseReason: 'budget', budgetUsd: 0.01 }).where(eq(runs.id, runId));
  expect((await t.post(`/api/runs/${runId}/resume`)).statusCode).toBe(409);
  expect((await t.patch(`/api/runs/${runId}`, { budgetUsd: null })).json().run.budgetUsd).toBeNull();
  expect((await t.post(`/api/runs/${runId}/resume`)).statusCode).toBe(200);
});

test('ajout d’un 7ᵉ modèle à une série terminée : seuls ses résultats sont exécutés', async () => {
  const t = await setup({ models: 8 });
  const [m0, , , , , , m6, m7] = t.modelIds as [string, string, string, string, string, string, string, string];
  const runId = await t.createRun(['Un', 'Deux'], { modelIds: t.modelIds.slice(0, 6) });
  await t.drain();
  expect((await t.runRow(runId)).status).toBe('completed');
  const before = new Map((await t.resultRows(runId)).map((r) => [r.id, r.startedAt]));
  expect(before.size).toBe(12);

  // Le second test porte une image : le nouveau modèle (sans vision) n'y est pas supporté.
  const [, second] = await t.db.select().from(runTests).where(eq(runTests.runId, runId)).orderBy(runTests.position);
  const image = { id: randomUUID(), originalName: 'a.png', mime: 'image/png', size: 10, sha256: 'a'.repeat(64), pages: null, storagePath: 'x' };
  await t.db.update(runTests).set({ snapshot: { ...second!.snapshot, attachments: [image] } }).where(eq(runTests.id, second!.id));

  // Modèle désactivé → 409 model_unavailable, rien n'est ajouté.
  await t.db.execute(sql`UPDATE models SET enabled = FALSE WHERE id = ${m7}`);
  const refused = await t.post(`/api/runs/${runId}/models`, { modelIds: [m7] });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.code).toBe('model_unavailable');
  expect(await t.resultRows(runId)).toHaveLength(12);

  t.clock.advance(60_000);
  const added = await t.post(`/api/runs/${runId}/models`, { modelIds: [m6, m0] }); // m0 déjà présent : ignoré
  expect(added.statusCode).toBe(200);
  expect(added.json().run).toMatchObject({ status: 'queued', modelCount: 7, completedAt: null });
  const fresh = (await t.resultRows(runId)).filter((r) => r.modelId === m6);
  expect(fresh.map((r) => r.status).sort()).toEqual(['pending', 'unsupported']);

  const calls: string[] = [];
  await t.drain(
    registryOf((inner) => ({
      ...inner,
      generate: (req, signal) => {
        calls.push(req.prompt);
        return inner.generate(req, signal);
      },
    })),
  );
  expect(calls).toEqual(['Un']);
  const rows = await t.resultRows(runId);
  expect(rows).toHaveLength(14);
  for (const r of rows) {
    if (before.has(r.id)) expect(r.startedAt).toEqual(before.get(r.id));
  }
  const ran = rows.find((r) => r.modelId === m6 && r.status !== 'unsupported')!;
  expect(ran).toMatchObject({ status: 'done', attempts: 1, startedAt: t.clock.now() });
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed', completedAt: t.clock.now(), activeJobId: null });
  expect(await t.auditActions()).toContain('run_models_added');
});

/** Résultat du modèle `modelId` passé en erreur définitive (avant toute exécution). */
async function failResult(t: Awaited<ReturnType<typeof setup>>, runId: string, modelId: string) {
  await t.db
    .update(results)
    .set({ status: 'error', attempts: 1, errorCode: 'auth_invalid', errorMessage: 'Clé refusée' })
    .where(and(eq(results.runId, runId), eq(results.modelId, modelId)));
}

test('série en cours : ajout d’un modèle et relance des erreurs gardent la tâche active, puis la série se termine', async () => {
  const t = await setup({ models: 3 });
  const [m0, m1, m2] = t.modelIds as [string, string, string];
  const runId = await t.createRun(['Un'], { modelIds: [m0, m1], concurrency: 1 });
  await failResult(t, runId, m1);
  const gate = deferred();
  const started = deferred();
  const calls: string[] = [];
  const registry = gatedRegistry(gate.promise, () => started.resolve(), calls);

  const worker = t.runOnce(registry);
  await started.promise; // un appel en vol : série running
  const jobId = (await t.runRow(runId)).activeJobId;
  const added = await t.post(`/api/runs/${runId}/models`, { modelIds: [m2] });
  expect(added.statusCode).toBe(200);
  expect(added.json().run).toMatchObject({ status: 'running', modelCount: 3 });
  const retried = await t.post(`/api/runs/${runId}/retry-errors`);
  expect(retried.statusCode).toBe(200);
  expect(retried.json().run.status).toBe('running');
  expect((await t.runRow(runId)).activeJobId).toBe(jobId);
  expect(await t.activeJobs(runId)).toHaveLength(1);
  const rows = await t.resultRows(runId);
  expect(rows.find((r) => r.modelId === m1)).toMatchObject({ status: 'pending', attempts: 0, errorCode: null });
  expect(rows.find((r) => r.modelId === m2)).toMatchObject({ status: 'pending' });

  gate.resolve();
  expect(await worker).toBe(true);
  await t.drain(registry);
  expect(calls).toHaveLength(3);
  expect((await t.resultRows(runId)).every((r) => r.status === 'done' && r.attempts === 1)).toBe(true);
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed', activeJobId: null });
});

test('série en pause (Utilisateur) : relance des erreurs et ajout d’un modèle la reprennent', async () => {
  const t = await setup({ models: 3 });
  const [m0, m1, m2] = t.modelIds as [string, string, string];
  const runId = await t.createRun(['Un'], { modelIds: [m0, m1] });
  await failResult(t, runId, m1);

  expect((await t.post(`/api/runs/${runId}/pause`)).statusCode).toBe(200);
  const retried = await t.post(`/api/runs/${runId}/retry-errors`);
  expect(retried.statusCode).toBe(200);
  expect(retried.json().run).toMatchObject({ status: 'queued', pauseReason: null });
  expect(await t.activeJobs(runId)).toHaveLength(1);

  expect((await t.post(`/api/runs/${runId}/pause`)).statusCode).toBe(200);
  const added = await t.post(`/api/runs/${runId}/models`, { modelIds: [m2] });
  expect(added.statusCode).toBe(200);
  expect(added.json().run).toMatchObject({ status: 'queued', pauseReason: null, modelCount: 3 });
  expect(await t.activeJobs(runId)).toHaveLength(1);

  await t.drain();
  expect((await t.resultRows(runId)).every((r) => r.status === 'done')).toBe(true);
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed', activeJobId: null });
});

test('série en pause budget : relance des erreurs et ajout d’un modèle la remettent en file, le moteur la remet aussitôt en pause', async () => {
  const t = await setup({ models: 3 });
  const [m0, m1, m2] = t.modelIds as [string, string, string];
  const runId = await t.createRun(['Un'], { modelIds: [m0, m1], budgetUsd: 0.01 });
  await failResult(t, runId, m1);
  // Dépense égale au plafond : aucun appel (coût maximal 0,01 $) ne tient.
  await t.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, (await t.runRow(runId)).activeJobId!));
  await t.db
    .update(runs)
    .set({ status: 'paused', pauseReason: 'budget', modelsCostUsd: 0.01, activeJobId: null })
    .where(eq(runs.id, runId));
  const calls: string[] = [];
  const registry = gatedRegistry(Promise.resolve(), () => {}, calls);

  const retried = await t.post(`/api/runs/${runId}/retry-errors`);
  expect(retried.statusCode).toBe(200);
  expect(retried.json().run).toMatchObject({ status: 'queued', pauseReason: null });
  await t.drain(registry);
  expect(calls).toHaveLength(0);
  expect(await t.runRow(runId)).toMatchObject({ status: 'paused', pauseReason: 'budget', activeJobId: null });

  const added = await t.post(`/api/runs/${runId}/models`, { modelIds: [m2] });
  expect(added.statusCode).toBe(200);
  expect(added.json().run).toMatchObject({ status: 'queued', modelCount: 3 });
  await t.drain(registry);
  expect(calls).toHaveLength(0);
  expect(await t.runRow(runId)).toMatchObject({ status: 'paused', pauseReason: 'budget', modelsCostUsd: 0.01 });

  // Plafond relevé : la reprise termine la série.
  expect((await t.patch(`/api/runs/${runId}`, { budgetUsd: 1 })).statusCode).toBe(200);
  expect((await t.post(`/api/runs/${runId}/resume`)).statusCode).toBe(200);
  await t.drain(registry);
  expect(calls).toHaveLength(3);
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed' });
});

test('PATCH : corps vide, pondération dont la somme ≠ 100, plafond à 5 décimales → 400, série inchangée', async () => {
  const t = await setup();
  const runId = await t.createRun(['Un'], { budgetUsd: 2 });
  for (const body of [
    {},
    { weights: { quality: 50, speed: 20, cost: 20, reliability: 20 } },
    { weights: { quality: 40, speed: 20, cost: 20, reliability: 10 } },
    { budgetUsd: 1.23456 },
    { budgetUsd: 0.00001 },
  ]) {
    const res = await t.patch(`/api/runs/${runId}`, body);
    expect(res.statusCode, JSON.stringify(body)).toBe(400);
    expect(res.json().error.code).toBe('validation');
  }
  expect(await t.runRow(runId)).toMatchObject({ budgetUsd: 2, weights: { quality: 50, speed: 20, cost: 20, reliability: 10 } });
  expect(await t.auditActions()).not.toContain('run_updated');
  // Plafond à 4 décimales : accepté.
  expect((await t.patch(`/api/runs/${runId}`, { budgetUsd: 1.2345 })).json().run.budgetUsd).toBe(1.2345);
});

test('relancer les erreurs : error et timeout repassent pending avec attempts 0, puis done', async () => {
  const t = await setup();
  const runId = await t.createRun(['Bonjour', 'Panne']);
  let broken = true;
  const registry = registryOf((inner) => ({
    ...inner,
    generate: (req, signal) => (broken && req.prompt === 'Panne' ? failing(httpError(401, 'Clé refusée', {}, [])) : inner.generate(req, signal)),
  }));
  await t.drain(registry);
  const failedRows = (await t.resultRows(runId)).filter((r) => r.status === 'error');
  expect(failedRows).toHaveLength(2);
  await t.db.update(results).set({ status: 'timeout', errorCode: 'timeout' }).where(eq(results.id, failedRows[0]!.id));
  expect((await t.runRow(runId)).status).toBe('completed');

  const res = await t.post(`/api/runs/${runId}/retry-errors`);
  expect(res.statusCode).toBe(200);
  expect(res.json().run.status).toBe('queued');
  const retried = (await t.resultRows(runId)).filter((r) => failedRows.some((f) => f.id === r.id));
  for (const r of retried) expect(r).toMatchObject({ status: 'pending', attempts: 0, errorCode: null, errorMessage: null, completedAt: null });
  expect(await t.activeJobs(runId)).toHaveLength(1);

  broken = false;
  await t.drain(registry);
  expect((await t.resultRows(runId)).every((r) => r.status === 'done' && r.attempts === 1)).toBe(true);
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed' });
  expect(await t.auditActions()).toContain('run_errors_retried');
});

test('redémarrage : résultats running + tâche failed → série interrupted ; reprendre la termine', async () => {
  const t = await setup();
  const runId = await t.createRun(['Un']);
  const run = await t.runRow(runId);
  const [first] = await t.resultRows(runId);
  // Tâche abandonnée après épuisement de ses reprises, résultat resté running.
  await t.db.update(jobs).set({ status: 'failed' }).where(eq(jobs.id, run.activeJobId!));
  await t.db.update(runs).set({ status: 'running', startedAt: START }).where(eq(runs.id, runId));
  await t.db.update(results).set({ status: 'running', attempts: 1 }).where(eq(results.id, first!.id));

  expect(await recoverRuns(t.db, t.clock.now())).toEqual({ enqueued: 0, interrupted: 1 });
  expect(await t.runRow(runId)).toMatchObject({ status: 'interrupted', activeJobId: null });
  expect(await recoverRuns(t.db, t.clock.now())).toEqual({ enqueued: 0, interrupted: 0 });

  expect((await t.post(`/api/runs/${runId}/resume`)).statusCode).toBe(200);
  await t.drain();
  const rows = await t.resultRows(runId);
  expect(rows.every((r) => r.status === 'done' && r.attempts === 1)).toBe(true);
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed' });
});

test('recoverRuns : série running sans tâche active → une tâche enfilée, pas deux (appels parallèles)', async () => {
  const t = await setup();
  const a = await t.createRun(['Un']);
  const b = await t.createRun(['Deux']);
  const untouched = await t.createRun(['Trois']); // tâche active encore en file
  const paused = await t.createRun(['Quatre']);
  // a : tâche active terminée ; b : plus de tâche active ; paused : en pause, jamais reprise d'office.
  await t.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, (await t.runRow(a)).activeJobId!));
  await t.db.update(runs).set({ status: 'running' }).where(eq(runs.id, a));
  await t.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, (await t.runRow(b)).activeJobId!));
  await t.db.update(runs).set({ activeJobId: null }).where(eq(runs.id, b));
  await t.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, (await t.runRow(paused)).activeJobId!));
  await t.db.update(runs).set({ status: 'paused', pauseReason: 'user' }).where(eq(runs.id, paused));

  const outcomes = await Promise.all([recoverRuns(t.db, t.clock.now()), recoverRuns(t.db, t.clock.now())]);
  expect(outcomes.reduce((s, o) => s + o.enqueued, 0)).toBe(2);
  expect(outcomes.reduce((s, o) => s + o.interrupted, 0)).toBe(0);
  for (const id of [a, b, untouched]) {
    const active = await t.activeJobs(id);
    expect(active).toHaveLength(1);
    expect((await t.runRow(id)).activeJobId).toBe(active[0]!.id);
  }
  expect(await t.activeJobs(paused)).toHaveLength(0);

  // /internal/tick : même reprise, comptée dans `runsEnqueued`.
  const tick = () => t.app.inject({ method: 'POST', url: '/internal/tick', headers: { 'x-cron-secret': testConfig().cronSecret } });
  expect((await tick()).json()).toEqual({ recovered: 0, failedStale: 0, scheduled: 0, runsEnqueued: 0 });
  await t.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, (await t.runRow(a)).activeJobId!));
  expect((await tick()).json()).toMatchObject({ runsEnqueued: 1 });
  expect(await t.activeJobs(a)).toHaveLength(1);
});

test('boucle du planificateur : une série sans tâche active est reprise', async () => {
  const t = await setup();
  const runId = await t.createRun(['Un']);
  await t.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, (await t.runRow(runId)).activeJobId!));
  await t.db.update(runs).set({ status: 'running', activeJobId: null }).where(eq(runs.id, runId));
  const logger = { info: vi.fn(), error: vi.fn() };
  const loop = startSchedulerLoop({ db: t.db, schedules: [], clock: () => t.clock.now(), logger }, { intervalMs: 5 });
  try {
    await until(async () => (await t.activeJobs(runId)).length === 1);
  } finally {
    await loop.stop();
  }
  expect(await t.activeJobs(runId)).toHaveLength(1);
  expect(logger.error).not.toHaveBeenCalled();
});

/** Tâche planifiée à 09:00 (heure de Paris), échue à START (10:00 à Paris). */
const demoSchedule: ScheduleEntry = { key: 'demo', times: ['09:00'], build: () => [{ type: 'demo' }] };

/** Deux séries `running` sans tâche active ; la reprise de la première échoue (déclencheur SQL sur `jobs`). */
async function brokenAndHealthyRuns(t: Awaited<ReturnType<typeof setup>>) {
  const broken = await t.createRun(['Un']);
  const healthy = await t.createRun(['Deux']);
  for (const id of [broken, healthy]) {
    await t.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, (await t.runRow(id)).activeJobId!));
    await t.db.update(runs).set({ status: 'running', activeJobId: null }).where(eq(runs.id, id));
  }
  await t.db.execute(
    sql.raw(
      `CREATE TRIGGER fail_run_job BEFORE INSERT ON jobs FOR EACH ROW BEGIN ` +
        `IF JSON_VALUE(NEW.payload, '$.runId') = '${broken}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'reprise impossible'; END IF; END`,
    ),
  );
  return { broken, healthy };
}

test('recoverRuns : une série dont la reprise échoue n’empêche ni les autres séries ni les tâches planifiées (/internal/tick → 200)', async () => {
  const t = await setup({ schedules: [demoSchedule] });
  const { broken, healthy } = await brokenAndHealthyRuns(t);
  const tick = await t.app.inject({ method: 'POST', url: '/internal/tick', headers: { 'x-cron-secret': testConfig().cronSecret } });
  expect(tick.statusCode).toBe(200);
  expect(tick.json()).toMatchObject({ scheduled: 1, runsEnqueued: 1 });
  expect(await t.activeJobs(healthy)).toHaveLength(1);
  expect(await t.activeJobs(broken)).toHaveLength(0);
  expect(await t.runRow(broken)).toMatchObject({ status: 'running', activeJobId: null });
  expect(await t.db.select().from(jobs).where(eq(jobs.type, 'demo'))).toHaveLength(1);
  // Erreur journalisée (message masqué par le journal), rattachée à la série.
  const events = await t.db.select().from(errorEvents);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ source: 'job', origin: 'run_recovery', targetType: 'run', targetId: broken });
});

test('boucle du planificateur : une série dont la reprise échoue n’arrête ni les autres séries ni les tâches planifiées', async () => {
  const t = await setup();
  const { broken, healthy } = await brokenAndHealthyRuns(t);
  const logger = { info: vi.fn(), error: vi.fn() };
  const loop = startSchedulerLoop({ db: t.db, schedules: [demoSchedule], clock: () => t.clock.now(), logger }, { intervalMs: 60_000 });
  await loop.stop(); // attend la fin du premier passage
  expect(await t.activeJobs(healthy)).toHaveLength(1);
  expect(await t.activeJobs(broken)).toHaveLength(0);
  expect(await t.db.select().from(jobs).where(eq(jobs.type, 'demo'))).toHaveLength(1);
  expect(logger.error).not.toHaveBeenCalled();
  expect(await t.db.select().from(errorEvents)).toHaveLength(1);
});

test('deux workers sur la même série : un seul exécute (activeJobId), aucun appel en double', async () => {
  const t = await setup();
  const runId = await t.createRun(['Un', 'Deux']);
  // Seconde tâche run_execute pour la même série (non désignée par activeJobId).
  await enqueue(t.db, { type: 'run_execute', payload: { runId } }, t.clock.now());
  const calls: string[] = [];
  const registry = registryOf((inner) => ({
    ...inner,
    generate: (req, signal) => {
      calls.push(`${req.model}|${req.prompt}`);
      return inner.generate(req, signal);
    },
  }));
  const ran = await Promise.all([t.runOnce(registry, 'w1'), t.runOnce(registry, 'w2')]);
  expect(ran).toEqual([true, true]);
  await t.drain(registry);
  expect(calls).toHaveLength(4);
  expect(new Set(calls).size).toBe(4);
  expect((await t.resultRows(runId)).every((r) => r.status === 'done' && r.attempts === 1)).toBe(true);
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed', activeJobId: null });
});

test('Utilisateur : 403 sur pause, resume, retry-errors, models, PATCH', async () => {
  const t = await setup();
  const runId = await t.createRun(['Un']);
  expect((await t.post(`/api/runs/${runId}/pause`, {}, t.user)).statusCode).toBe(403);
  expect((await t.post(`/api/runs/${runId}/resume`, {}, t.user)).statusCode).toBe(403);
  expect((await t.post(`/api/runs/${runId}/retry-errors`, {}, t.user)).statusCode).toBe(403);
  expect((await t.post(`/api/runs/${runId}/models`, { modelIds: [t.modelIds[0]] }, t.user)).statusCode).toBe(403);
  expect((await t.patch(`/api/runs/${runId}`, { budgetUsd: 1 }, t.user)).statusCode).toBe(403);
  expect(await t.runRow(runId)).toMatchObject({ status: 'queued', budgetUsd: null });
  // Série inconnue : 404 pour l'Admin.
  expect((await t.post(`/api/runs/${randomUUID()}/pause`)).statusCode).toBe(404);
});
