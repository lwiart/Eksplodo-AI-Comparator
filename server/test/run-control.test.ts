import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, expect, test, vi } from 'vitest';
import { auditLog } from '../src/db/schema/core.js';
import { jobs } from '../src/db/schema/jobs.js';
import { results, runTests, runs } from '../src/db/schema/runs.js';
import { enqueue, type JobHandlers } from '../src/modules/jobs/queue.js';
import { startSchedulerLoop } from '../src/modules/jobs/scheduler-loop.js';
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
async function setup(opts: { models?: number } = {}) {
  resetFakeCallCounters();
  const t = await buildTestApp({ now: START, fakeLlm: true });
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
  // Trois appels réservent tout le plafond : le quatrième lancement met la série en pause, avant toute réponse.
  await until(async () => (await t.runRow(runId)).status === 'paused');
  expect(started).toBe(3);
  gate.resolve();
  expect(await worker).toBe(true);

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

test('reprendre sans relever le plafond → 409 budget_exceeded', async () => {
  const t = await setup();
  const runId = await t.createRun(['Un'], { budgetUsd: 0.03 });
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

  // Plafond relevé au-dessus de la dépense : reprise acceptée.
  expect((await t.patch(`/api/runs/${runId}`, { budgetUsd: 0.0301 })).statusCode).toBe(200);
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
