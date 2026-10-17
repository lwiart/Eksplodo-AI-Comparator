// Banc d'essai des séries notées par le juge (moteur et recalcul) : application de test, faux fournisseur, deux juges.
import { tmpdir } from 'node:os';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { jobs } from '../../src/db/schema/jobs.js';
import { aiUsage, results, runs } from '../../src/db/schema/runs.js';
import type { JobHandlers } from '../../src/modules/jobs/queue.js';
import { runWorkerOnce } from '../../src/modules/jobs/worker.js';
import { resetFakeCallCounters } from '../../src/modules/providers/fake.js';
import { createProviderRegistry, type ProviderLike } from '../../src/modules/providers/registry.js';
import type { GenerateEvent, GenerateRequest, ProviderAdapter } from '../../src/modules/providers/types.js';
import { executeRunSlice, type EngineDeps } from '../../src/modules/runs/engine.js';
import { JUDGE_SYSTEM_PROMPT } from '../../src/modules/scoring/judge-prompt.js';
import { buildTestApp, loginAs, seedModel, seedProvider, seedUser, testConfig, type TestApp } from './test-app.js';

const PW = 'motdepasse-solide';
export const START = new Date('2026-10-17T08:00:00.000Z');
const created: TestApp[] = [];

/** À appeler dans `afterEach` : détruit les applications créées par `setupJudgeRun`. */
export async function destroyJudgeRuns(): Promise<void> {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}

type Wrap = (inner: ProviderAdapter, provider: ProviderLike) => ProviderAdapter;

/** Registre du faux fournisseur, sans attente réelle ; chaque adaptateur peut être enveloppé. */
export function registryOf(wrap: Wrap = (inner) => inner): EngineDeps['registry'] {
  const base = createProviderRegistry({
    encryptionKey: testConfig().encryptionKey,
    fakeLlm: true,
    appBaseUrl: 'http://localhost:3000',
    fakeSleep: async () => {},
  });
  return { adapterFor: (p: ProviderLike) => wrap(base.adapterFor(p), p) };
}

export const isJudgeCall = (req: GenerateRequest) => req.system === JUDGE_SYSTEM_PROMPT;

/** Réponse fixe : texte, usage (entrée 5, sortie `outputTokens`), fin. */
export async function* reply(text: string, outputTokens: number): AsyncGenerator<GenerateEvent> {
  yield { type: 'text', delta: text };
  yield { type: 'usage', inputTokens: 5, outputTokens };
  yield { type: 'finish', reason: 'stop' };
}

export const failing = (err: unknown): AsyncIterable<GenerateEvent> =>
  (async function* () {
    throw err;
  })();

export async function until(cond: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition non atteinte');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Critère contenant la directive du faux juge : il répond par ce JSON. */
export const judgeDirective = (score: number, rationale = 'Réponse correcte') =>
  `Exactitude [[fake:judge={"score": ${score}, "rationale": "${rationale}"}]]`;

export const sumUsd = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 1e6) / 1e6;

/**
 * Application de test (faux fournisseur), un Admin et un Utilisateur connectés ; modèles évalués à 0 $ en entrée et
 * 10 $ en sortie par million de tokens (coût maximal d'un appel de 1 000 tokens : 0,01 $) ; deux juges sur un second
 * fournisseur, même tarif (coût maximal d'un appel du juge : 800 tokens × 10 $/M = 0,008 $).
 */
export async function setupJudgeRun(opts: { models?: number; judgeMaxConcurrency?: number } = {}) {
  resetFakeCallCounters();
  const t = await buildTestApp({ now: START, fakeLlm: true, schedules: [] });
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
  const judgeProvider = await seedProvider(t.db, { maxConcurrency: opts.judgeMaxConcurrency ?? 8 });
  const modelIds: string[] = [];
  for (let i = 0; i < (opts.models ?? 2); i++) {
    const m = await seedModel(t.db, {
      providerId: provider.id,
      apiModelId: `fake-modele-${i}`,
      displayName: `Modèle ${i}`,
      inputPricePerM: 0,
      outputPricePerM: 10,
    });
    modelIds.push(m.id);
  }
  const judges: string[] = [];
  for (const i of [1, 2]) {
    const m = await seedModel(t.db, {
      providerId: judgeProvider.id,
      apiModelId: `fake-juge-${i}`,
      displayName: `Juge ${i}`,
      inputPricePerM: 0,
      outputPricePerM: 10,
    });
    judges.push(m.id);
  }

  /** Tests notés par le juge (critère `criteria`), puis la série (premier juge par défaut). */
  async function createRun(prompts: string[], criteria: string, extra: Record<string, unknown> = {}): Promise<string> {
    const testIds: string[] = [];
    for (const [i, prompt] of prompts.entries()) {
      const res = await api.post('/api/tests', {
        name: `Test ${i}`,
        category: 'Culture',
        userPrompt: prompt,
        scoringMethod: 'judge',
        scoringConfig: { criteria },
      });
      expect(res.statusCode).toBe(201);
      testIds.push(res.json().test.id as string);
    }
    const res = await api.post('/api/runs', { name: 'Série', testIds, modelIds, concurrency: 4, judgeModelId: judges[0], ...extra });
    expect(res.statusCode).toBe(201);
    return res.json().run.id as string;
  }

  const clock = () => t.clock.now();
  const engineDeps = (registry = registryOf(), over: Partial<EngineDeps> = {}): EngineDeps => ({
    db: t.db,
    registry,
    config: { dataDir: tmpdir() },
    sleep: async () => {},
    ...over,
  });
  const handlersFor = (deps: EngineDeps): JobHandlers => ({ run_execute: (job, ctx) => executeRunSlice(deps, job, ctx) });
  const runOnce = (deps: EngineDeps = engineDeps()) => runWorkerOnce({ db: t.db, clock, workerId: 'w1' }, handlersFor(deps));

  /** Exécute les tâches prêtes jusqu'à épuisement ; une tâche en échec fait échouer le test. */
  async function drain(deps: EngineDeps = engineDeps()): Promise<number> {
    let n = 0;
    while (await runOnce(deps)) if (++n > 50) throw new Error('trop de tranches');
    const failed = await t.db.select().from(jobs).where(sql`${jobs.error} IS NOT NULL`);
    if (failed.length > 0) throw new Error(`tâche en échec : ${failed[0]!.error}`);
    return n;
  }

  const runRow = async (runId: string) => (await t.db.select().from(runs).where(eq(runs.id, runId)))[0]!;
  const resultRows = (runId: string) => t.db.select().from(results).where(eq(results.runId, runId));
  const judgeUsage = (runId: string) =>
    t.db.select().from(aiUsage).where(and(eq(aiUsage.runId, runId), eq(aiUsage.origin, 'judge')));
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

  return { ...t, admin, user, ...api, modelIds, judges, createRun, engineDeps, runOnce, drain, runRow, resultRows, judgeUsage, activeJobs };
}
