import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { models } from '../src/db/schema/catalog.js';
import { aiUsage, results, runs } from '../src/db/schema/runs.js';
import { httpError } from '../src/modules/providers/errors.js';
import type { GenerateRequest } from '../src/modules/providers/types.js';
import { recoverRuns } from '../src/modules/runs/run-job.js';
import type { TestSnapshot } from '../src/modules/runs/snapshot.js';
import { claimJudgement, judgeCallMaxCostUsd, judgeInputTokens } from '../src/modules/scoring/judge-items.js';
import { buildJudgeRequest } from '../src/modules/scoring/judge-prompt.js';
import {
  START,
  destroyJudgeRuns,
  failing,
  isJudgeCall,
  judgeDirective,
  registryOf,
  reply,
  setupJudgeRun as setup,
  sumUsd as sum,
  until,
} from './helpers/judge-run.js';

afterEach(destroyJudgeRuns, 60_000);

test('série avec tests notés par le juge : chaque réponse est notée, coût du juge à part, ai_usage judge', async () => {
  const t = await setup();
  const runId = await t.createRun(['Capitale de la France ?', 'Deux plus deux ?'], judgeDirective(8), { repetitions: 2 });
  const judgeRequests: GenerateRequest[] = [];
  const registry = registryOf((inner) => ({
    ...inner,
    generate: (req, signal) => {
      if (isJudgeCall(req)) judgeRequests.push(req);
      return inner.generate(req, signal);
    },
  }));
  await t.drain(t.engineDeps(registry));

  const rows = await t.resultRows(runId);
  expect(rows).toHaveLength(8);
  for (const r of rows) {
    expect(r).toMatchObject({ status: 'done', scoreStatus: 'done', autoScore: 8, judgeRationale: 'Réponse correcte' });
    expect(r.judgeCostUsd).toBeGreaterThan(0);
  }
  const run = await t.runRow(runId);
  expect(run).toMatchObject({ status: 'completed', activeJobId: null });
  expect(run.judgeCostUsd).toBeGreaterThan(0);
  // Coût du juge jamais imputé aux modèles évalués.
  expect(run.modelsCostUsd).toBeCloseTo(sum(rows.map((r) => r.costUsd!)), 6);
  expect(run.judgeCostUsd).toBeCloseTo(sum(rows.map((r) => r.judgeCostUsd!)), 6);
  const usage = await t.judgeUsage(runId);
  expect(usage).toHaveLength(8);
  expect(usage.every((u) => u.modelId === t.judges[0])).toBe(true);
  expect(sum(usage.map((u) => u.costUsd))).toBeCloseTo(run.judgeCostUsd, 6);
  const runUsage = await t.db.select().from(aiUsage).where(and(eq(aiUsage.runId, runId), eq(aiUsage.origin, 'run')));
  expect(sum(runUsage.map((u) => u.costUsd))).toBeCloseTo(run.modelsCostUsd, 6);

  // Requêtes du juge : modèle juge, température 0, 800 tokens, sans le nom du modèle évalué, réponse encadrée.
  expect(judgeRequests).toHaveLength(8);
  for (const req of judgeRequests) {
    expect(req).toMatchObject({ model: 'fake-juge-1', temperature: 0, maxTokens: 800 });
    expect(req.prompt).not.toMatch(/Modèle \d|fake-modele/);
    expect(req.prompt).toContain('<reponse_a_evaluer>');
  }
  const responses = new Set(rows.map((r) => r.responseText));
  expect(judgeRequests.every((req) => [...responses].some((text) => req.prompt.includes(text!)))).toBe(true);
});

test('JSON invalide puis valide → note ; deux fois invalide → judge_failed, coût des deux appels compté', async () => {
  const t = await setup({ models: 1 });
  // Juge scripté : chaque appel consomme la réponse suivante (800 tokens de sortie, soit 0,008 $).
  const script: string[] = [];
  const registry = registryOf((inner) => ({
    ...inner,
    generate: (req, signal) => (isJudgeCall(req) ? reply(script.shift() ?? 'aucune réponse prévue', 800) : inner.generate(req, signal)),
  }));

  script.push('Voici ma note : 6/10', '{"score": 6, "rationale": "Correct mais incomplet"}');
  const first = await t.createRun(['Un'], 'Exactitude');
  await t.drain(t.engineDeps(registry));
  const [ok] = await t.resultRows(first);
  expect(ok).toMatchObject({ scoreStatus: 'done', autoScore: 6, judgeRationale: 'Correct mais incomplet' });
  expect(ok!.judgeCostUsd).toBeCloseTo(0.016, 6);
  expect(await t.judgeUsage(first)).toHaveLength(2);
  expect(await t.runRow(first)).toMatchObject({ status: 'completed', judgeCostUsd: 0.016 });

  script.push('pas de JSON', '{"score": 42, "rationale": "hors bornes"}');
  const second = await t.createRun(['Deux'], 'Exactitude');
  await t.drain(t.engineDeps(registry));
  const [ko] = await t.resultRows(second);
  expect(ko).toMatchObject({ scoreStatus: 'judge_failed', autoScore: null, judgeRationale: 'Réponse du juge illisible' });
  expect(ko!.judgeCostUsd).toBeCloseTo(0.016, 6);
  expect(await t.judgeUsage(second)).toHaveLength(2);
  const run = await t.runRow(second);
  expect(run).toMatchObject({ status: 'completed', judgeCostUsd: 0.016 });
  expect(run.modelsCostUsd).toBeCloseTo(ko!.costUsd!, 6);
  expect(script).toHaveLength(0);
});

test('erreur du juge : réessayable (2 s puis 8 s) puis note ; définitive → judge_failed au message masqué, non facturé', async () => {
  const t = await setup({ models: 1 });
  let judgeCalls = 0;
  const sleeps: number[] = [];
  const flaky = registryOf((inner) => ({
    ...inner,
    generate: (req, signal) => {
      if (!isJudgeCall(req)) return inner.generate(req, signal);
      return ++judgeCalls <= 2 ? failing(httpError(503, 'Indisponible', {}, [])) : reply('{"score": 7, "rationale": "Bien"}', 100);
    },
  }));
  const first = await t.createRun(['Un'], 'Exactitude');
  await t.drain(t.engineDeps(flaky, { sleep: async (ms) => void sleeps.push(ms) }));
  expect(judgeCalls).toBe(3);
  expect(sleeps).toEqual([2000, 8000]);
  const [ok] = await t.resultRows(first);
  expect(ok).toMatchObject({ scoreStatus: 'done', autoScore: 7 });
  expect(await t.judgeUsage(first)).toHaveLength(1); // seul l'appel réussi est facturé

  const refused = registryOf((inner) => ({
    ...inner,
    generate: (req, signal) =>
      isJudgeCall(req) ? failing(httpError(401, 'clé refusée sk-abcdefghijklmnop', {}, [])) : inner.generate(req, signal),
  }));
  const second = await t.createRun(['Deux'], 'Exactitude');
  await t.drain(t.engineDeps(refused));
  const [ko] = await t.resultRows(second);
  expect(ko).toMatchObject({ status: 'done', scoreStatus: 'judge_failed', autoScore: null, judgeCostUsd: null });
  expect(ko!.judgeRationale).toMatch(/^Juge indisponible : /);
  expect(ko!.judgeRationale).not.toContain('sk-abcdefghijklmnop');
  expect(await t.judgeUsage(second)).toHaveLength(0);
  expect(await t.runRow(second)).toMatchObject({ status: 'completed', judgeCostUsd: 0 });
});

test('juge désactivé pendant la série : notes judge_failed avec une justification claire, série terminée', async () => {
  const t = await setup({ models: 1 });
  const runId = await t.createRun(['Un', 'Deux'], judgeDirective(5));
  await t.db.update(models).set({ enabled: false }).where(eq(models.id, t.judges[0]!));
  await t.drain();
  const rows = await t.resultRows(runId);
  expect(rows).toHaveLength(2);
  for (const r of rows) {
    expect(r).toMatchObject({ status: 'done', scoreStatus: 'judge_failed', autoScore: null });
    expect(r.judgeRationale).toMatch(/^Juge indisponible : .*désactivé/);
  }
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed', judgeCostUsd: 0 });
});

test('le juge partage la concurrence : jamais plus de runs.concurrency appels simultanés, génération et juge confondus', async () => {
  const t = await setup({ judgeMaxConcurrency: 1 });
  let active = 0;
  let maxActive = 0;
  let judgeActive = 0;
  let judgeMax = 0;
  let generationActive = 0;
  let mixed = false;
  const registry = registryOf(() => ({
    async *generate(req) {
      const judge = isJudgeCall(req);
      maxActive = Math.max(maxActive, ++active);
      if (judge) judgeMax = Math.max(judgeMax, ++judgeActive);
      else generationActive++;
      if (judgeActive > 0 && generationActive > 0) mixed = true;
      try {
        // Appels assez longs pour se chevaucher même quand la base répond lentement (suite complète en parallèle) ; les
        // générations du dernier test, plus longues, sont encore en vol quand les premiers appels du juge partent.
        await new Promise((r) => setTimeout(r, !judge && req.prompt === 'Trois' ? 300 : 40));
        yield* reply(judge ? '{"score": 9, "rationale": "Très bien"}' : 'Paris', 10);
      } finally {
        active--;
        if (judge) judgeActive--;
        else generationActive--;
      }
    },
    listModels: async () => [],
  }));
  const runId = await t.createRun(['Un', 'Deux', 'Trois'], 'Exactitude', { concurrency: 3 });
  await t.drain(t.engineDeps(registry));
  const rows = await t.resultRows(runId);
  expect(rows.every((r) => r.status === 'done' && r.scoreStatus === 'done' && r.autoScore === 9)).toBe(true);
  // Bornes de sécurité seulement (le nombre exact d'appels simultanés dépend de la vitesse de la base) ; les générations
  // du dernier test durent 300 ms : au moins un appel du juge part pendant qu'elles sont en vol.
  expect(maxActive).toBeLessThanOrEqual(3);
  expect(judgeMax).toBeLessThanOrEqual(1);
  expect(mixed).toBe(true);
});

test('plafond atteint pendant la notation : pause budget, aucun dépassement, reprise après relèvement', async () => {
  const t = await setup();
  // Génération : 2 × 0,01 $ ; juge : coût maximal = coût réel = 0,008 $ ; plafond 0,03 $ : un seul appel du juge tient.
  const budget = 0.03;
  const runId = await t.createRun(['Un'], 'Exactitude', { budgetUsd: budget });
  const registry = registryOf(() => ({
    generate: (req) => (isJudgeCall(req) ? reply('{"score": 8, "rationale": "Bien"}', 800) : reply('Réponse', 1000)),
    listModels: async () => [],
  }));
  await t.drain(t.engineDeps(registry));

  const run = await t.runRow(runId);
  expect(run).toMatchObject({ status: 'paused', pauseReason: 'budget', activeJobId: null });
  expect(run.modelsCostUsd).toBeCloseTo(0.02, 6);
  expect(run.judgeCostUsd).toBeCloseTo(0.008, 6);
  expect(run.modelsCostUsd + run.judgeCostUsd).toBeLessThanOrEqual(budget);
  const rows = await t.resultRows(runId);
  expect(rows.every((r) => r.status === 'done')).toBe(true);
  expect(rows.filter((r) => r.scoreStatus === 'done')).toHaveLength(1);
  expect(rows.filter((r) => r.scoreStatus === 'pending')).toHaveLength(1);

  // Avancement : une note du juge en attente ; minimum utile = coût maximal du prochain appel du juge.
  const progress = (await t.get(`/api/runs/${runId}/progress`)).json().progress;
  expect(progress).toMatchObject({ judgePending: 1, status: 'paused', pauseReason: 'budget' });
  expect(progress.counts).toMatchObject({ pending: 0, running: 0 });
  expect(progress.nextCallMaxCostUsd).toBeCloseTo(0.008, 6);
  // Reprise sans relèvement : le prochain appel du juge ne tient pas.
  const refused = await t.post(`/api/runs/${runId}/resume`);
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.code).toBe('budget_exceeded');

  expect((await t.patch(`/api/runs/${runId}`, { budgetUsd: 1 })).statusCode).toBe(200);
  expect((await t.post(`/api/runs/${runId}/resume`)).statusCode).toBe(200);
  await t.drain(t.engineDeps(registry));
  const done = await t.runRow(runId);
  expect(done).toMatchObject({ status: 'completed', pauseReason: null });
  expect(done.judgeCostUsd).toBeCloseTo(0.016, 6);
  expect((await t.resultRows(runId)).every((r) => r.scoreStatus === 'done' && r.autoScore === 8)).toBe(true);
  expect((await t.get(`/api/runs/${runId}/progress`)).json().progress.judgePending).toBe(0);
});

test('la série ne passe completed qu’une fois toutes les notes du juge rendues', async () => {
  const t = await setup();
  // Chaque appel de génération avance l'horloge de 30 ms ; tranche de 50 ms : la première tranche s'achève après les
  // deux générations, notes du juge encore en attente.
  const registry = registryOf((inner) => ({
    ...inner,
    async *generate(req, signal) {
      if (!isJudgeCall(req)) t.clock.advance(30);
      yield* inner.generate(req, signal);
    },
  }));
  const runId = await t.createRun(['Un'], judgeDirective(8), { concurrency: 1 });
  const deps = t.engineDeps(registry, { sliceMs: 50 });
  const firstJobId = (await t.runRow(runId)).activeJobId!;
  expect(await t.runOnce(deps)).toBe(true);

  const rows = await t.resultRows(runId);
  expect(rows.every((r) => r.status === 'done' && r.scoreStatus === 'pending')).toBe(true);
  const run = await t.runRow(runId);
  expect(run.status).toBe('running');
  expect(run.completedAt).toBeNull();
  expect(run.activeJobId).not.toBe(firstJobId);
  expect((await t.activeJobs(runId)).map((j) => j.id)).toEqual([run.activeJobId]);
  const progress = (await t.get(`/api/runs/${runId}/progress`)).json().progress;
  expect(progress.counts).toMatchObject({ pending: 0, running: 0, done: 2 });
  expect(progress.judgePending).toBe(2);

  await t.drain(deps);
  expect((await t.resultRows(runId)).every((r) => r.scoreStatus === 'done' && r.autoScore === 8)).toBe(true);
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed', activeJobId: null });
});

test('prise exclusive : pendant l’appel du juge, une autre tâche ne peut pas prendre la note, rendue une seule fois', async () => {
  const t = await setup({ models: 1 });
  let judgeCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const registry = registryOf((inner) => ({
    ...inner,
    async *generate(req, signal) {
      if (!isJudgeCall(req)) return yield* inner.generate(req, signal);
      judgeCalls++;
      await gate;
      yield* reply('{"score": 3, "rationale": "Moyen"}', 10);
    },
  }));
  const runId = await t.createRun(['Un'], 'Exactitude');
  const worker = t.runOnce(t.engineDeps(registry));
  await until(() => judgeCalls === 1);
  const [r] = await t.resultRows(runId);
  expect(r).toMatchObject({ status: 'done', scoreStatus: 'pending' });
  const activeJobId = (await t.runRow(runId)).activeJobId;
  expect(r!.judgeClaimedBy).toBe(activeJobId);
  // Une autre tâche tente de prendre la même note : refusé, la prise reste à la tâche active.
  const other = { runId, resultId: r!.id, judgeModelId: t.judges[0]!, jobId: randomUUID() };
  expect(await claimJudgement(t.db, other)).toBe('taken');
  expect(await claimJudgement(t.db, { ...other, jobId: activeJobId! })).toBe('taken'); // déjà prise : idempotent
  expect((await t.resultRows(runId))[0]!.judgeClaimedBy).toBe(activeJobId);
  release();
  expect(await worker).toBe(true);
  expect(judgeCalls).toBe(1);
  const [scored] = await t.resultRows(runId);
  expect(scored).toMatchObject({ scoreStatus: 'done', autoScore: 3, judgeClaimedBy: null });
  expect(await t.judgeUsage(runId)).toHaveLength(1);
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed' });
});

test('juge changé par un recalcul pendant la tranche (ancien juge désactivé) : les notes suivantes sont rendues par le nouveau juge', async () => {
  const t = await setup({ models: 2 });
  const runId = await t.createRun(['Un'], 'Exactitude', { concurrency: 1 });
  // La tranche démarre avec un juge désactivé ; pendant la première génération, l'Admin choisit le second juge.
  await t.db.update(models).set({ enabled: false }).where(eq(models.id, t.judges[0]!));
  let switched = false;
  const judgeModels: string[] = [];
  const registry = registryOf((inner) => ({
    ...inner,
    async *generate(req, signal) {
      if (isJudgeCall(req)) {
        judgeModels.push(req.model);
        return yield* reply('{"score": 6, "rationale": "Nouveau juge"}', 10);
      }
      if (!switched) {
        switched = true;
        const res = await t.post(`/api/runs/${runId}/rescore`, { scope: 'run', judgeModelId: t.judges[1] });
        expect(res.json()).toEqual({ queued: 0 });
      }
      yield* inner.generate(req, signal);
    },
  }));
  expect(await t.runOnce(t.engineDeps(registry))).toBe(true);
  const rows = await t.resultRows(runId);
  expect(rows).toHaveLength(2);
  for (const r of rows) expect(r).toMatchObject({ status: 'done', scoreStatus: 'done', autoScore: 6, judgeRationale: 'Nouveau juge' });
  expect(judgeModels).toEqual(['fake-juge-2', 'fake-juge-2']);
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed', judgeModelId: t.judges[1] });
});

test('réponse illisible puis prise retirée par un recalcul : aucun second appel facturé dans la tranche', async () => {
  const t = await setup({ models: 1 });
  const runId = await t.createRun(['Un'], 'Exactitude');
  let judgeCalls = 0;
  const registry = registryOf((inner) => ({
    ...inner,
    async *generate(req, signal) {
      if (!isJudgeCall(req)) return yield* inner.generate(req, signal);
      if (++judgeCalls === 1) {
        // Recalcul pendant le premier appel : la prise est retirée avant le second appel prévu (réponse illisible).
        const [r] = await t.resultRows(runId);
        expect((await t.post(`/api/runs/${runId}/rescore`, { scope: 'result', resultId: r!.id })).json()).toEqual({ queued: 1 });
        return yield* reply('pas de JSON', 100);
      }
      yield* reply('{"score": 7, "rationale": "Bien"}', 100);
    },
  }));
  expect(await t.runOnce(t.engineDeps(registry))).toBe(true);
  expect(judgeCalls).toBe(1);
  const [r] = await t.resultRows(runId);
  expect(r).toMatchObject({ scoreStatus: 'pending', autoScore: null, judgeClaimedBy: null });
  expect(r!.judgeCostUsd).toBeCloseTo(0.001, 6); // l'appel illisible reste compté
  expect((await t.runRow(runId)).status).toBe('running'); // note en attente : tranche suivante
  await t.drain(t.engineDeps(registry));
  expect((await t.resultRows(runId))[0]).toMatchObject({ scoreStatus: 'done', autoScore: 7 });
  expect(judgeCalls).toBe(2);
});

test('erreur réessayable puis prise retirée par un recalcul : pas de nouvelle tentative', async () => {
  const t = await setup({ models: 1 });
  const runId = await t.createRun(['Un'], 'Exactitude');
  let judgeCalls = 0;
  const sleep = async () => {
    // Recalcul pendant l'attente de la nouvelle tentative.
    const [r] = await t.resultRows(runId);
    await t.post(`/api/runs/${runId}/rescore`, { scope: 'result', resultId: r!.id });
  };
  const registry = registryOf((inner) => ({
    ...inner,
    generate: (req, signal) => {
      if (!isJudgeCall(req)) return inner.generate(req, signal);
      return ++judgeCalls === 1 ? failing(httpError(503, 'Indisponible', {}, [])) : reply('{"score": 5, "rationale": "Bien"}', 100);
    },
  }));
  expect(await t.runOnce(t.engineDeps(registry, { sleep }))).toBe(true);
  expect(judgeCalls).toBe(1);
  expect((await t.resultRows(runId))[0]).toMatchObject({ scoreStatus: 'pending', judgeClaimedBy: null });
});

test('recalcul avec un autre juge pendant un appel du juge : verdict en vol écarté, son coût compté, note rendue par le nouveau juge', async () => {
  const t = await setup({ models: 1 });
  const runId = await t.createRun(['Un'], 'Exactitude');
  const calls: string[] = [];
  const registry = registryOf((inner) => ({
    ...inner,
    async *generate(req, signal) {
      if (!isJudgeCall(req)) return yield* inner.generate(req, signal);
      calls.push(req.model);
      if (calls.length === 1) {
        const res = await t.post(`/api/runs/${runId}/rescore`, { scope: 'run', judgeModelId: t.judges[1] });
        expect(res.json()).toEqual({ queued: 1 });
      }
      const score = req.model === 'fake-juge-1' ? 8 : 4;
      yield* reply(`{"score": ${score}, "rationale": "Note de ${req.model}"}`, 100);
    },
  }));
  expect(await t.runOnce(t.engineDeps(registry))).toBe(true);
  // Le verdict de l'ancien juge n'est pas écrit ; son appel est facturé.
  const [stale] = await t.resultRows(runId);
  expect(stale).toMatchObject({ scoreStatus: 'pending', autoScore: null, judgeRationale: null, judgeClaimedBy: null });
  expect(stale!.judgeCostUsd).toBeCloseTo(0.001, 6);
  const usage = await t.judgeUsage(runId);
  expect(usage.map((u) => u.modelId)).toEqual([t.judges[0]]);
  expect((await t.runRow(runId)).judgeCostUsd).toBeCloseTo(0.001, 6);

  await t.drain(t.engineDeps(registry));
  expect(calls).toEqual(['fake-juge-1', 'fake-juge-2']);
  const [scored] = await t.resultRows(runId);
  expect(scored).toMatchObject({ scoreStatus: 'done', autoScore: 4, judgeRationale: 'Note de fake-juge-2' });
  expect(scored!.judgeCostUsd).toBeCloseTo(0.002, 6);
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed', judgeModelId: t.judges[1] });
});

test('prise orpheline (tâche interrompue) : libérée au début de la tranche suivante, note rendue une fois', async () => {
  const t = await setup({ models: 1 });
  const runId = await t.createRun(['Un'], judgeDirective(4));
  await t.drain();
  // Note remise en attente et prise par une tâche disparue.
  await t.db
    .update(results)
    .set({ scoreStatus: 'pending', autoScore: null, judgeRationale: null, judgeClaimedBy: '00000000-0000-4000-8000-000000000000' })
    .where(eq(results.runId, runId));
  await t.db.update(runs).set({ status: 'running', completedAt: null }).where(eq(runs.id, runId));
  expect(await recoverRuns(t.db, START)).toEqual({ enqueued: 1, interrupted: 0 });
  await t.drain();
  const [r] = await t.resultRows(runId);
  expect(r).toMatchObject({ scoreStatus: 'done', autoScore: 4, judgeClaimedBy: null });
  expect(await t.judgeUsage(runId)).toHaveLength(2);
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed' });
});

test('coût maximal d’un appel du juge : entrée estimée (requête, réponse, pièces lues par le juge) × prix d’entrée + 800 × prix de sortie', () => {
  const snapshot: TestSnapshot = {
    testId: 't1',
    name: 'Capitale',
    category: 'Culture',
    tags: [],
    systemPrompt: null,
    userPrompt: 'Quelle est la capitale de la France ?',
    temperature: 0.2,
    maxTokens: 1000,
    scoringMethod: 'judge',
    scoringConfig: { criteria: 'Doit citer Paris.' },
    attachments: [
      { id: 'a', originalName: 'a.png', mime: 'image/png', size: 1, sha256: 'x', pages: null, storagePath: 'p/a' },
      { id: 'b', originalName: 'b.pdf', mime: 'application/pdf', size: 1, sha256: 'y', pages: 3, storagePath: 'p/b' },
    ],
  };
  const judge = { id: 'j', apiModelId: 'juge', supportsVision: true, supportsPdf: false };
  const req = buildJudgeRequest({ snapshot, response: '', judgeApiModelId: 'juge', judgeSupports: { vision: true, pdf: false }, attachments: [] });
  const textTokens = Math.ceil((req.system!.length + req.prompt.length + 400) / 4);
  // Image lue (1 500), PDF ignoré par un juge sans PDF.
  expect(judgeInputTokens(snapshot, 400, judge)).toBe(textTokens + 1500);
  expect(judgeInputTokens(snapshot, 400, { ...judge, supportsPdf: true })).toBe(textTokens + 1500 + 3 * 800);
  expect(judgeCallMaxCostUsd(1000, { inputPricePerM: 2, outputPricePerM: 10 })).toBeCloseTo((1000 * 2 + 800 * 10) / 1e6, 12);
});
