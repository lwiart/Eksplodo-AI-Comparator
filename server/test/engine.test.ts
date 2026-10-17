import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Db } from '../src/db/client.js';
import { errorEvents } from '../src/db/schema/errors.js';
import { jobs } from '../src/db/schema/jobs.js';
import { aiUsage, results, runTests, runs } from '../src/db/schema/runs.js';
import { tests } from '../src/db/schema/tests.js';
import { InterruptedError, getJob, type Job, type JobContext, type JobHandlers } from '../src/modules/jobs/queue.js';
import { runWorkerOnce } from '../src/modules/jobs/worker.js';
import { ProviderError, httpError } from '../src/modules/providers/errors.js';
import { resetFakeCallCounters } from '../src/modules/providers/fake.js';
import { createProviderRegistry, type ProviderLike } from '../src/modules/providers/registry.js';
import type { GenerateEvent, ProviderAdapter } from '../src/modules/providers/types.js';
import { executeRunSlice, type EngineDeps } from '../src/modules/runs/engine.js';
import { createRunsService } from '../src/modules/runs/runs.service.js';
import { monthSpend, recordUsage } from '../src/modules/usage/usage.js';
import { createUsersRepo } from '../src/modules/users/users.repo.js';
import { seedModel, seedProvider, testConfig } from './helpers/test-app.js';
import { createTestClock } from './helpers/test-clock.js';
import { createTestDb } from './helpers/test-db.js';

const START = new Date('2026-10-17T08:00:00.000Z');

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeEach(async () => {
  t = await createTestDb();
  resetFakeCallCounters();
});
afterEach(async () => {
  await t.destroy();
}, 60_000);

/** Registre du faux fournisseur, sans attente réelle. */
function fakeRegistry() {
  return createProviderRegistry({
    encryptionKey: testConfig().encryptionKey,
    fakeLlm: true,
    appBaseUrl: 'http://localhost:3000',
    fakeSleep: async () => {},
  });
}

type Wrap = (inner: ProviderAdapter, provider: ProviderLike) => ProviderAdapter;
/** Registre dont chaque adaptateur est enveloppé (instrumentation, pannes simulées). */
function wrappedRegistry(wrap: Wrap): EngineDeps['registry'] {
  const base = fakeRegistry();
  return { adapterFor: (p: ProviderLike) => wrap(base.adapterFor(p), p) };
}

const failing = (err: unknown): AsyncIterable<GenerateEvent> =>
  (async function* () {
    throw err;
  })();

function engineDeps(over: Partial<EngineDeps> = {}): EngineDeps {
  return { db: t.db, registry: fakeRegistry(), config: { dataDir: tmpdir() }, sleep: async () => {}, ...over };
}

type ModelSpec = { apiModelId: string; providerId: string };

async function seedRun(opts: {
  prompts: string[];
  models?: ModelSpec[];
  repetitions?: number;
  concurrency?: number;
  maxConcurrency?: number;
}) {
  const user = await createUsersRepo(t.db).insert({ email: `admin-${randomUUID()}@acme.fr`, name: 'Admin', role: 'admin' });
  let specs = opts.models;
  if (!specs) {
    const provider = await seedProvider(t.db, { maxConcurrency: opts.maxConcurrency ?? 2 });
    specs = [
      { apiModelId: 'fake-rapide', providerId: provider.id },
      { apiModelId: 'fake-equilibre', providerId: provider.id },
    ];
  }
  const modelIds: string[] = [];
  for (const [i, s] of specs.entries()) {
    const m = await seedModel(t.db, {
      providerId: s.providerId,
      apiModelId: s.apiModelId,
      displayName: `Modèle ${i}`,
      inputPricePerM: 2,
      outputPricePerM: 8,
    });
    modelIds.push(m.id);
  }
  const testIds: string[] = [];
  for (const [i, prompt] of opts.prompts.entries()) {
    const id = randomUUID();
    await t.db.insert(tests).values({
      id,
      name: `Test ${i}`,
      category: 'Culture',
      tags: [],
      userPrompt: prompt,
      scoringMethod: 'manual',
      scoringConfig: {},
    });
    testIds.push(id);
  }
  const service = createRunsService({ db: t.db, clock: () => START, registry: fakeRegistry(), config: { dataDir: tmpdir() } });
  const run = await service.create(
    { userId: user.id, role: 'admin', email: user.email, name: user.name },
    { name: 'Série', testIds, modelIds, repetitions: opts.repetitions ?? 1, concurrency: opts.concurrency ?? 4 },
  );
  return { runId: run.id, modelIds, testIds };
}

async function runRow(runId: string) {
  const [row] = await t.db.select().from(runs).where(eq(runs.id, runId));
  return row!;
}

async function resultRows(runId: string) {
  return t.db.select().from(results).where(eq(results.runId, runId));
}

async function activeJobs(runId: string) {
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

function handlersFor(deps: EngineDeps): JobHandlers {
  return { run_execute: (job, ctx) => executeRunSlice(deps, job, ctx) };
}

/** Exécute les tâches prêtes jusqu'à épuisement ; une tâche en échec fait échouer le test. */
async function drain(deps: EngineDeps, clock: () => Date = () => START): Promise<number> {
  let n = 0;
  while (await runWorkerOnce({ db: t.db, clock, workerId: 'w1' }, handlersFor(deps))) {
    if (++n > 50) throw new Error('trop de tranches');
  }
  const failed = await t.db.select().from(jobs).where(sql`${jobs.error} IS NOT NULL`);
  if (failed.length > 0) throw new Error(`tâche en échec : ${failed[0]!.error}`);
  return n;
}

function ctxOf(over: Partial<JobContext> = {}): JobContext {
  return { db: t.db, now: () => START, signal: new AbortController().signal, reportProgress: async () => {}, ...over };
}

async function activeJob(runId: string): Promise<Job> {
  return (await getJob(t.db, (await runRow(runId)).activeJobId!))!;
}

test('série complète : tous les résultats done, coût cumulé = Σ résultats = Σ ai_usage, statut completed', async () => {
  const { runId } = await seedRun({ prompts: ['Capitale de la France ?', 'Deux plus deux ?'], repetitions: 2 });
  await drain(engineDeps());

  const rows = await resultRows(runId);
  expect(rows).toHaveLength(8);
  for (const r of rows) {
    expect(r).toMatchObject({ status: 'done', attempts: 1, finishReason: 'stop', costSource: 'computed', scoreStatus: 'awaiting_manual' }); // tests manuels : note inchangée
    expect(r.responseText!.length).toBeGreaterThan(0);
    expect(r.inputTokens).toBeGreaterThan(0);
    expect(r.outputTokens).toBeGreaterThan(0);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.startedAt).toEqual(START);
    expect(r.completedAt).toEqual(START);
  }
  const run = await runRow(runId);
  expect(run).toMatchObject({ status: 'completed', activeJobId: null, startedAt: START, completedAt: START });
  const sumResults = rows.reduce((s, r) => s + r.costUsd!, 0);
  const usage = await t.db.select().from(aiUsage).where(eq(aiUsage.runId, runId));
  expect(usage).toHaveLength(8);
  expect(usage.every((u) => u.origin === 'run')).toBe(true);
  const sumUsage = usage.reduce((s, u) => s + u.costUsd, 0);
  expect(run.modelsCostUsd).toBeCloseTo(sumResults, 6);
  expect(sumUsage).toBeCloseTo(sumResults, 6);
  expect(await activeJobs(runId)).toHaveLength(0);
  // Signe de vie de la file : avancement final enregistré dans la tâche.
  const [job] = await t.db.select().from(jobs).where(eq(jobs.type, 'run_execute'));
  expect(job!.progress).toEqual({ done: 8, total: 8 });
});

test('ordre : alternance des modèles dans une répétition', async () => {
  const calls: string[] = [];
  const registry = wrappedRegistry((inner) => ({
    ...inner,
    generate: (req, signal) => {
      calls.push(`${req.model}|${req.prompt}`);
      return inner.generate(req, signal);
    },
  }));
  await seedRun({ prompts: ['Premier', 'Second'], repetitions: 2, concurrency: 1 });
  await drain(engineDeps({ registry }));
  const round = ['fake-rapide|Premier', 'fake-equilibre|Premier', 'fake-rapide|Second', 'fake-equilibre|Second'];
  expect(calls).toEqual([...round, ...round]);
});

test('concurrence globale et par fournisseur jamais dépassées', async () => {
  const p1 = await seedProvider(t.db, { maxConcurrency: 2 });
  const p2 = await seedProvider(t.db, { maxConcurrency: 3 });
  let active = 0;
  let maxActive = 0;
  const perProvider = new Map<string, { active: number; max: number }>();
  const registry = wrappedRegistry((_inner, provider) => ({
    async *generate() {
      const pp = perProvider.get(provider.id) ?? { active: 0, max: 0 };
      perProvider.set(provider.id, pp);
      active++;
      pp.active++;
      maxActive = Math.max(maxActive, active);
      pp.max = Math.max(pp.max, pp.active);
      try {
        // Appels assez longs pour se chevaucher même quand la base répond lentement (suite complète en parallèle).
        await new Promise((r) => setTimeout(r, 50));
        yield { type: 'text', delta: 'ok' };
        yield { type: 'usage', inputTokens: 3, outputTokens: 1 };
        yield { type: 'finish', reason: 'stop' };
      } finally {
        active--;
        pp.active--;
      }
    },
    listModels: async () => [],
  }));
  const { runId } = await seedRun({
    prompts: ['Un', 'Deux', 'Trois'],
    concurrency: 4,
    models: [
      { apiModelId: 'a', providerId: p1.id },
      { apiModelId: 'b', providerId: p1.id },
      { apiModelId: 'c', providerId: p2.id },
      { apiModelId: 'd', providerId: p2.id },
    ],
  });
  await drain(engineDeps({ registry }));
  expect((await resultRows(runId)).every((r) => r.status === 'done')).toBe(true);
  expect(maxActive).toBe(4);
  expect(perProvider.get(p1.id)!.max).toBe(2);
  expect(perProvider.get(p2.id)!.max).toBeLessThanOrEqual(3);
});

test('[[fake:429]] puis succès : deux nouvelles tentatives au plus, délais 2 s puis 8 s', async () => {
  // Deux refus puis une réponse : trois appels, attentes de 2 s puis 8 s.
  let n = 0;
  const sleeps: number[] = [];
  const registry = wrappedRegistry((inner) => ({
    ...inner,
    generate: (req, signal) => (++n <= 2 ? failing(httpError(429, 'Limite', {}, [])) : inner.generate(req, signal)),
  }));
  const first = await seedRun({ prompts: ['Bonjour'], models: undefined });
  await t.db.delete(results).where(and(eq(results.runId, first.runId), eq(results.modelId, first.modelIds[1]!)));
  await drain(engineDeps({ registry, sleep: async (ms) => void sleeps.push(ms) }));
  expect(n).toBe(3);
  expect(sleeps).toEqual([2000, 8000]);
  const [ok] = await resultRows(first.runId);
  expect(ok).toMatchObject({ status: 'done', attempts: 3, errorCode: null });

  // Refus permanent ([[fake:429]]) : trois appels au plus, puis erreur définitive.
  sleeps.length = 0;
  const calls: string[] = [];
  const counting = wrappedRegistry((inner) => ({
    ...inner,
    generate: (req, signal) => {
      calls.push(req.prompt);
      return inner.generate(req, signal);
    },
  }));
  const second = await seedRun({ prompts: ['[[fake:429]] Bonjour'] });
  await t.db.delete(results).where(and(eq(results.runId, second.runId), eq(results.modelId, second.modelIds[1]!)));
  await drain(engineDeps({ registry: counting, sleep: async (ms) => void sleeps.push(ms) }));
  expect(calls).toHaveLength(3);
  expect(sleeps).toEqual([2000, 8000]);
  const [ko] = await resultRows(second.runId);
  expect(ko).toMatchObject({ status: 'error', attempts: 3, errorCode: 'rate_limited' });
  expect(ko!.errorMessage).toContain('Limite de débit');
  expect((await runRow(second.runId)).status).toBe('completed');

  // Retry-After : respecté, plafonné à 30 s.
  sleeps.length = 0;
  let m = 0;
  const retryAfter = wrappedRegistry((inner) => ({
    ...inner,
    generate: (req, signal) => {
      m++;
      if (m === 1) return failing(new ProviderError('rate_limited', { retryAfterMs: 45_000 }));
      if (m === 2) return failing(new ProviderError('provider_unavailable', { retryAfterMs: 5_000 }));
      return inner.generate(req, signal);
    },
  }));
  const third = await seedRun({ prompts: ['Salut'] });
  await t.db.delete(results).where(and(eq(results.runId, third.runId), eq(results.modelId, third.modelIds[1]!)));
  await drain(engineDeps({ registry: retryAfter, sleep: async (ms) => void sleeps.push(ms) }));
  expect(sleeps).toEqual([30_000, 5_000]);
  expect((await resultRows(third.runId))[0]).toMatchObject({ status: 'done', attempts: 3 });
});

test('erreur définitive (401) : status error, pas de nouvelle tentative', async () => {
  let n = 0;
  const sleeps: number[] = [];
  const registry = wrappedRegistry(() => ({
    generate: () => {
      n++;
      return failing(httpError(401, 'clé refusée sk-abcdefghijklmnop', {}, []));
    },
    listModels: async () => [],
  }));
  const { runId } = await seedRun({ prompts: ['Bonjour'] });
  await drain(engineDeps({ registry, sleep: async (ms) => void sleeps.push(ms) }));
  expect(n).toBe(2); // un appel par modèle
  expect(sleeps).toEqual([]);
  const rows = await resultRows(runId);
  for (const r of rows) {
    expect(r).toMatchObject({ status: 'error', attempts: 1, errorCode: 'auth_invalid', costUsd: null });
    expect(r.errorMessage).not.toContain('sk-abcdefghijklmnop');
  }
  const run = await runRow(runId);
  expect(run).toMatchObject({ status: 'completed', modelsCostUsd: 0 });
  expect(await t.db.select().from(aiUsage)).toHaveLength(0);
});

test('tranche : après sliceMs, plus de lancement, tranche suivante enfilée, une seule tâche active', async () => {
  const clock = createTestClock(START);
  let calls = 0;
  const registry = wrappedRegistry((inner) => ({
    ...inner,
    async *generate(req, signal) {
      calls++;
      clock.advance(30);
      yield* inner.generate(req, signal);
    },
  }));
  const { runId } = await seedRun({ prompts: ['Un', 'Deux'], concurrency: 1 });
  const deps = engineDeps({ registry, sliceMs: 50 });
  const firstJobId = (await runRow(runId)).activeJobId!;

  expect(await runWorkerOnce({ db: t.db, clock: () => clock.now(), workerId: 'w1' }, handlersFor(deps))).toBe(true);
  // Appel 1 lancé à t0, fini à t0 + 30 ; appel 2 lancé à t0 + 30, fini à t0 + 60 : la tranche est échue.
  expect(calls).toBe(2);
  const rows = await resultRows(runId);
  expect(rows.filter((r) => r.status === 'done')).toHaveLength(2);
  expect(rows.filter((r) => r.status === 'pending')).toHaveLength(2);
  const run = await runRow(runId);
  expect(run.status).toBe('running');
  expect(run.activeJobId).not.toBe(firstJobId);
  const active = await activeJobs(runId);
  expect(active.map((j) => j.id)).toEqual([run.activeJobId]);
  expect(active[0]!.status).toBe('queued');
  expect((await getJob(t.db, firstJobId))!.status).toBe('done');

  await drain(deps, () => clock.now());
  expect(calls).toBe(4);
  expect((await resultRows(runId)).every((r) => r.status === 'done' && r.attempts === 1)).toBe(true);
  expect((await runRow(runId)).status).toBe('completed');
  expect(await activeJobs(runId)).toHaveLength(0);
});

test('tranche échue pendant une nouvelle tentative : résultat remis en pending, tentative gardée', async () => {
  const clock = createTestClock(START);
  let n = 0;
  const registry = wrappedRegistry((inner) => ({
    ...inner,
    generate: (req, signal) => {
      n++;
      clock.advance(30);
      return n === 1 ? failing(httpError(503, 'Indisponible', {}, [])) : inner.generate(req, signal);
    },
  }));
  const { runId, modelIds } = await seedRun({ prompts: ['Un'], concurrency: 1 });
  await t.db.delete(results).where(and(eq(results.runId, runId), eq(results.modelId, modelIds[1]!)));
  // Attente de 2 s au-delà de l'échéance (50 ms) : pas de nouvelle tentative dans cette tranche.
  const deps = engineDeps({ registry, sliceMs: 50 });
  expect(await runWorkerOnce({ db: t.db, clock: () => clock.now(), workerId: 'w1' }, handlersFor(deps))).toBe(true);
  expect(n).toBe(1);
  expect((await resultRows(runId))[0]).toMatchObject({ status: 'pending', attempts: 1 });
  await drain(deps, () => clock.now());
  expect((await resultRows(runId))[0]).toMatchObject({ status: 'done', attempts: 2 });
});

test('tâche périmée (activeJobId différent) : ne fait rien', async () => {
  let calls = 0;
  const registry = wrappedRegistry((inner) => ({
    ...inner,
    generate: (req, signal) => {
      calls++;
      return inner.generate(req, signal);
    },
  }));
  const { runId } = await seedRun({ prompts: ['Un'] });
  const job = await activeJob(runId);
  await executeRunSlice(engineDeps({ registry }), { ...job, id: randomUUID() }, ctxOf());
  expect(calls).toBe(0);
  const run = await runRow(runId);
  expect(run).toMatchObject({ status: 'queued', activeJobId: job.id, startedAt: null });
  expect((await resultRows(runId)).every((r) => r.status === 'pending')).toBe(true);

  // Série en pause : la tâche active elle-même ne lance rien.
  await t.db.update(runs).set({ status: 'paused', pauseReason: 'user' }).where(eq(runs.id, runId));
  await executeRunSlice(engineDeps({ registry }), job, ctxOf());
  expect(calls).toBe(0);
  expect((await runRow(runId)).status).toBe('paused');
});

test('résultats running orphelins remis en pending au début de la tranche, tentative rendue', async () => {
  const { runId } = await seedRun({ prompts: ['Un'] });
  const [a, b] = await resultRows(runId);
  await t.db.update(results).set({ status: 'running', attempts: 1 }).where(eq(results.id, a!.id));
  await t.db.update(results).set({ status: 'running', attempts: 0 }).where(eq(results.id, b!.id));
  await drain(engineDeps());
  const rows = await resultRows(runId);
  expect(rows.map((r) => [r.status, r.attempts])).toEqual([
    ['done', 1],
    ['done', 1],
  ]);
});

test('onResultFinished appelé une fois par résultat done', async () => {
  const finished: string[] = [];
  const { runId } = await seedRun({ prompts: ['Bonjour', '[[fake:500]] Erreur'], repetitions: 2 });
  await drain(engineDeps({ onResultFinished: async (id) => void finished.push(id) }));
  const rows = await resultRows(runId);
  const done = rows.filter((r) => r.status === 'done').map((r) => r.id);
  expect(done).toHaveLength(4);
  expect(rows.filter((r) => r.status === 'error')).toHaveLength(4);
  expect([...finished].sort()).toEqual([...done].sort());
});

test('arrêt du processus : appels annulés, résultats pending avec tentative rendue, InterruptedError', async () => {
  const controller = new AbortController();
  let started = 0;
  let allStarted!: () => void;
  const ready = new Promise<void>((resolve) => (allStarted = resolve));
  const registry = wrappedRegistry(() => ({
    async *generate(_req, signal) {
      if (++started === 2) allStarted();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw signal.reason;
    },
    listModels: async () => [],
  }));
  const { runId } = await seedRun({ prompts: ['Un', 'Deux'], concurrency: 2 });
  const job = await activeJob(runId);
  const slice = executeRunSlice(engineDeps({ registry }), job, ctxOf({ signal: controller.signal }));
  await ready;
  controller.abort();
  await expect(slice).rejects.toBeInstanceOf(InterruptedError);
  expect(started).toBe(2);
  expect((await resultRows(runId)).map((r) => [r.status, r.attempts])).toEqual([
    ['pending', 0],
    ['pending', 0],
    ['pending', 0],
    ['pending', 0],
  ]);
  expect(await runRow(runId)).toMatchObject({ status: 'running', activeJobId: job.id });
});

test('erreur pendant les lancements : les appels en cours se terminent et sont enregistrés avant que la tranche échoue', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started = 0;
  const registry = wrappedRegistry((inner) => ({
    ...inner,
    async *generate(req, signal) {
      started++;
      await gate;
      yield* inner.generate(req, signal);
    },
  }));
  const { runId } = await seedRun({ prompts: ['Un', 'Deux'], concurrency: 2 });
  // La deuxième prise de résultat (UPDATE results) échoue : connexion perdue.
  let updates = 0;
  const flaky = new Proxy(t.db, {
    get(target, prop, receiver) {
      if (prop === 'update') {
        return (table: unknown) => {
          if (table === results && ++updates === 2) {
            setTimeout(release, 20); // l'appel en cours se termine après l'erreur
            throw new Error('connexion perdue');
          }
          return target.update(table as typeof results);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Db;
  const job = await activeJob(runId);
  await expect(executeRunSlice(engineDeps({ db: flaky, registry }), job, ctxOf())).rejects.toThrow('connexion perdue');
  expect(started).toBe(1);
  const rows = await resultRows(runId);
  expect(rows.filter((r) => r.status === 'done')).toHaveLength(1);
  expect(rows.filter((r) => r.status === 'running')).toHaveLength(0);
  expect(rows.filter((r) => r.status === 'pending')).toHaveLength(3);
  // Aucune écriture finale : la tâche reste active pour sa reprise.
  expect(await runRow(runId)).toMatchObject({ status: 'running', activeJobId: job.id });
});

test('onResultFinished en échec : erreur journalisée, résultat done, la tranche continue', async () => {
  let calls = 0;
  const { runId } = await seedRun({ prompts: ['Un', 'Deux'] });
  await drain(
    engineDeps({
      onResultFinished: async () => {
        calls++;
        throw new Error('notation impossible');
      },
    }),
  );
  expect(calls).toBe(4);
  expect((await resultRows(runId)).every((r) => r.status === 'done')).toBe(true);
  expect((await runRow(runId)).status).toBe('completed');
  const events = await t.db.select().from(errorEvents);
  expect(events).toHaveLength(1); // occurrences regroupées
  expect(events[0]).toMatchObject({ source: 'job', origin: 'run_execute', severity: 'normale', occurrences: 4, targetType: 'result' });
  expect(events[0]!.message).toContain('notation impossible');
});

test('pièce jointe illisible : erreur définitive attachment_unreadable avec le code, cause journalisée', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { runId, modelIds } = await seedRun({ prompts: ['Décris'] });
    await t.db.delete(results).where(and(eq(results.runId, runId), eq(results.modelId, modelIds[1]!)));
    const [rt] = await t.db.select().from(runTests).where(eq(runTests.runId, runId));
    const attachment = {
      id: randomUUID(),
      originalName: 'absente.png',
      mime: 'image/png',
      size: 10,
      sha256: 'a'.repeat(64),
      pages: null,
      storagePath: `attachments/${randomUUID()}/${randomUUID()}`,
    };
    await t.db
      .update(runTests)
      .set({ snapshot: { ...rt!.snapshot, attachments: [attachment] } })
      .where(eq(runTests.id, rt!.id));
    await drain(engineDeps());
    const [r] = await resultRows(runId);
    expect(r).toMatchObject({ status: 'error', attempts: 1, errorCode: 'attachment_unreadable' });
    expect(r!.errorMessage).toContain('ENOENT');
    expect(warn).toHaveBeenCalledWith('run_execute : pièce jointe illisible', { resultId: r!.id, code: 'ENOENT' });
  } finally {
    warn.mockRestore();
  }
});

test('modèle à raisonnement : coût sans double compte du raisonnement', async () => {
  const { runId } = await seedRun({ prompts: ['[[fake:reasoning]] Pourquoi ?'] });
  await drain(engineDeps());
  for (const r of await resultRows(runId)) {
    expect(r).toMatchObject({ status: 'done', reasoningTokens: 24, tokensEstimated: false });
    expect(r.outputTokens! * 4).toBe(r.responseText!.length); // sortie = texte visible seulement
    // Prix : 2 $ en entrée, 8 $ en sortie (raisonnement compris), par million de tokens.
    const expected = Math.round(((r.inputTokens! * 2 + (r.outputTokens! + 24) * 8) / 1_000_000) * 1e6) / 1e6;
    expect(r.costUsd).toBeCloseTo(expected, 6);
  }
});

test('monthSpend : mois civil en Europe/Paris, part du juge séparée', async () => {
  const { modelIds } = await seedRun({ prompts: ['Un'] });
  const modelId = modelIds[0]!;
  const base = { runId: null, modelId, inputTokens: 1, outputTokens: 1, reasoningTokens: 0 };
  // 30 septembre 23 h 30 à Paris : mois précédent.
  await recordUsage(t.db, { ...base, origin: 'run', costUsd: 100, now: new Date('2026-09-30T21:30:00.000Z') });
  // 1er octobre 0 h 30 à Paris : octobre.
  await recordUsage(t.db, { ...base, origin: 'run', costUsd: 1.5, now: new Date('2026-09-30T22:30:00.000Z') });
  await recordUsage(t.db, { ...base, origin: 'judge', costUsd: 0.25, now: new Date('2026-10-16T12:00:00.000Z') });
  await recordUsage(t.db, { ...base, origin: 'quick_try', costUsd: 0, now: new Date('2026-10-16T12:00:00.000Z') });
  // 1er novembre 0 h 30 à Paris : mois suivant.
  await recordUsage(t.db, { ...base, origin: 'run', costUsd: 50, now: new Date('2026-10-31T23:30:00.000Z') });
  const spend = await monthSpend(t.db, new Date('2026-10-17T10:00:00.000Z'));
  expect(spend.totalUsd).toBeCloseTo(1.75, 6);
  expect(spend.judgeUsd).toBeCloseTo(0.25, 6);
  expect(await monthSpend(t.db, new Date('2026-12-01T10:00:00.000Z'))).toEqual({ totalUsd: 0, judgeUsd: 0 });
});
