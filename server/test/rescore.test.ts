import { and, eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { auditLog } from '../src/db/schema/core.js';
import { models } from '../src/db/schema/catalog.js';
import { aiUsage, results, runTests } from '../src/db/schema/runs.js';
import { destroyJudgeRuns, isJudgeCall, registryOf, reply, setupJudgeRun as setup, sumUsd } from './helpers/judge-run.js';

afterEach(destroyJudgeRuns, 60_000);

/** Juges scriptés : le premier note 8, le second 4 (100 tokens de sortie, soit 0,001 $ l'appel). */
const judgesRegistry = () =>
  registryOf((inner) => ({
    ...inner,
    generate: (req, signal) => {
      if (!isJudgeCall(req)) return inner.generate(req, signal);
      const score = req.model === 'fake-juge-1' ? 8 : 4;
      return reply(`{"score": ${score}, "rationale": "Note de ${req.model}"}`, 100);
    },
  }));

const auditOf = async (t: Awaited<ReturnType<typeof setup>>, action: string) =>
  t.db.select().from(auditLog).where(eq(auditLog.action, action));

test('recalcul de toute la série avec un autre juge : notes remplacées, judgeModelId changé, coût du juge cumulé', async () => {
  const t = await setup();
  const registry = judgesRegistry();
  const runId = await t.createRun(['Un', 'Deux'], 'Exactitude');
  await t.drain(t.engineDeps(registry));
  expect((await t.resultRows(runId)).every((r) => r.scoreStatus === 'done' && r.autoScore === 8)).toBe(true);
  const before = await t.runRow(runId);
  expect(before).toMatchObject({ status: 'completed' });
  expect(before.judgeCostUsd).toBeCloseTo(0.004, 6);
  // Une note imposée n'est pas touchée par le recalcul.
  const [forced] = await t.resultRows(runId);
  await t.db.update(results).set({ overrideScore: 9.5 }).where(eq(results.id, forced!.id));

  const res = await t.post(`/api/runs/${runId}/rescore`, { scope: 'run', judgeModelId: t.judges[1] });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ queued: 4 });
  const queued = await t.runRow(runId);
  expect(queued).toMatchObject({ status: 'queued', judgeModelId: t.judges[1], completedAt: null });
  expect(await t.activeJobs(runId)).toHaveLength(1);
  for (const r of await t.resultRows(runId)) {
    expect(r).toMatchObject({ status: 'done', scoreStatus: 'pending', autoScore: null, judgeRationale: null });
  }
  // Avancement : série en recalcul, aucune génération restante, notes du juge en attente.
  const progress = (await t.get(`/api/runs/${runId}/progress`)).json().progress;
  expect(progress).toMatchObject({ status: 'queued', judgePending: 4 });
  expect(progress.counts).toMatchObject({ pending: 0, running: 0, done: 4 });

  await t.drain(t.engineDeps(registry));
  const rows = await t.resultRows(runId);
  for (const r of rows) {
    expect(r).toMatchObject({ scoreStatus: 'done', autoScore: 4, judgeRationale: 'Note de fake-juge-2' });
    expect(r.judgeCostUsd).toBeCloseTo(0.002, 6); // deux appels du juge par résultat, cumulés
  }
  expect(rows.find((r) => r.id === forced!.id)!.overrideScore).toBe(9.5);
  const after = await t.runRow(runId);
  expect(after).toMatchObject({ status: 'completed', judgeModelId: t.judges[1] });
  expect(after.judgeCostUsd).toBeCloseTo(0.008, 6);
  expect(after.modelsCostUsd).toBeCloseTo(before.modelsCostUsd, 6); // aucune nouvelle génération
  const usage = await t.judgeUsage(runId);
  expect(usage.filter((u) => u.modelId === t.judges[0])).toHaveLength(4);
  expect(usage.filter((u) => u.modelId === t.judges[1])).toHaveLength(4);
  expect(sumUsd(usage.map((u) => u.costUsd))).toBeCloseTo(after.judgeCostUsd, 6);
  expect(await t.db.select().from(aiUsage).where(and(eq(aiUsage.runId, runId), eq(aiUsage.origin, 'run')))).toHaveLength(4);
  const [entry] = await auditOf(t, 'run_rescored');
  expect(entry).toMatchObject({ targetType: 'run', targetId: runId });
  expect(entry!.details).toMatchObject({ scope: 'run', judgeModelId: t.judges[1], queued: 4 });
});

test('recalcul d’un seul résultat ; Utilisateur → 403 ; juge indisponible → 409', async () => {
  const t = await setup();
  const registry = judgesRegistry();
  const runId = await t.createRun(['Un', 'Deux'], 'Exactitude');
  await t.drain(t.engineDeps(registry));
  const [target, ...others] = await t.resultRows(runId);

  // Utilisateur : refusé, rien ne change.
  const forbidden = await t.post(`/api/runs/${runId}/rescore`, { scope: 'result', resultId: target!.id }, t.user);
  expect(forbidden.statusCode).toBe(403);
  expect((await t.runRow(runId)).status).toBe('completed');

  // Juge indisponible (désactivé) : 409, rien ne change.
  await t.db.update(models).set({ enabled: false }).where(eq(models.id, t.judges[1]!));
  const unavailable = await t.post(`/api/runs/${runId}/rescore`, { scope: 'result', resultId: target!.id, judgeModelId: t.judges[1] });
  expect(unavailable.statusCode).toBe(409);
  expect(unavailable.json().error.code).toBe('model_unavailable');
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed', judgeModelId: t.judges[0] });
  expect((await t.resultRows(runId)).every((r) => r.scoreStatus === 'done')).toBe(true);
  await t.db.update(models).set({ enabled: true }).where(eq(models.id, t.judges[1]!));

  // Un seul résultat, avec le second juge : seul celui-ci est renoté.
  const res = await t.post(`/api/runs/${runId}/rescore`, { scope: 'result', resultId: target!.id, judgeModelId: t.judges[1] });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ queued: 1 });
  await t.drain(t.engineDeps(registry));
  const rows = new Map((await t.resultRows(runId)).map((r) => [r.id, r]));
  expect(rows.get(target!.id)).toMatchObject({ scoreStatus: 'done', autoScore: 4 });
  for (const o of others) expect(rows.get(o.id)).toMatchObject({ scoreStatus: 'done', autoScore: 8 });
  expect(await t.runRow(runId)).toMatchObject({ status: 'completed', judgeModelId: t.judges[1] });
  expect(await t.judgeUsage(runId)).toHaveLength(5);
});

test('recalcul d’un test : seuls ses résultats ; périmètre invalide → 400, inconnu → 404, test non noté par le juge → 409', async () => {
  const t = await setup();
  const registry = judgesRegistry();
  const runId = await t.createRun(['Un', 'Deux'], 'Exactitude');
  await t.drain(t.engineDeps(registry));
  const [first] = await t.db.select().from(runTests).where(eq(runTests.runId, runId)).orderBy(runTests.position);

  expect((await t.post(`/api/runs/${runId}/rescore`, { scope: 'test' })).statusCode).toBe(400);
  expect((await t.post(`/api/runs/${runId}/rescore`, { scope: 'result' })).statusCode).toBe(400);
  expect((await t.post(`/api/runs/${runId}/rescore`, { scope: 'tout' })).statusCode).toBe(400);
  const unknown = await t.post(`/api/runs/${runId}/rescore`, { scope: 'result', resultId: '00000000-0000-4000-8000-000000000000' });
  expect(unknown.statusCode).toBe(404);
  expect((await t.post('/api/runs/00000000-0000-4000-8000-000000000000/rescore', { scope: 'run' })).statusCode).toBe(404);

  const res = await t.post(`/api/runs/${runId}/rescore`, { scope: 'test', runTestId: first!.id });
  expect(res.json()).toEqual({ queued: 2 }); // juge inchangé (premier juge)
  const rows = await t.resultRows(runId);
  expect(rows.filter((r) => r.scoreStatus === 'pending').map((r) => r.runTestId)).toEqual([first!.id, first!.id]);
  await t.drain(t.engineDeps(registry));
  expect((await t.resultRows(runId)).every((r) => r.scoreStatus === 'done' && r.autoScore === 8)).toBe(true);
  expect(await t.judgeUsage(runId)).toHaveLength(6);

  // Test manuel dans la série : non renotable par le juge.
  await t.db
    .update(runTests)
    .set({ snapshot: { ...first!.snapshot, scoringMethod: 'manual', scoringConfig: {} } })
    .where(eq(runTests.id, first!.id));
  const manual = await t.post(`/api/runs/${runId}/rescore`, { scope: 'test', runTestId: first!.id });
  expect(manual.statusCode).toBe(409);
  expect(manual.json().error.code).toBe('not_rescorable');
});
