import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { auditLog } from '../src/db/schema/core.js';
import { manualScores, results } from '../src/db/schema/runs.js';
import { finalScore } from '../src/modules/scoring/override.js';
import { buildTestApp, loginAs, seedModel, seedProvider, seedUser, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const created: TestApp[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

test('finalScore : imposée > méthode ; manuelle = moyenne ; null sans note', () => {
  expect(finalScore({ overrideScore: 3, autoScore: 9, manualAvg: null, method: 'judge' })).toBe(3);
  expect(finalScore({ overrideScore: null, autoScore: 9, manualAvg: null, method: 'judge' })).toBe(9);
  expect(finalScore({ overrideScore: null, autoScore: 7, manualAvg: null, method: 'expected' })).toBe(7);
  expect(finalScore({ overrideScore: null, autoScore: null, manualAvg: 6.5, method: 'manual' })).toBe(6.5);
  expect(finalScore({ overrideScore: null, autoScore: null, manualAvg: null, method: 'manual' })).toBeNull();
  expect(finalScore({ overrideScore: 0, autoScore: 9, manualAvg: null, method: 'judge' })).toBe(0);
});

async function setup() {
  const t = await buildTestApp({ fakeLlm: true });
  created.push(t);
  const adminRow = await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin' });
  const userRow = await seedUser(t.db, { email: 'user@acme.fr', role: 'user' });
  const admin = await loginAs(t.app, 'admin@acme.fr', PW);
  const user = await loginAs(t.app, 'user@acme.fr', PW);
  const call = (method: 'POST' | 'PUT', url: string, s: typeof admin, payload: unknown) =>
    t.app.inject({ method, url, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf }, payload: payload as object });
  const provider = await seedProvider(t.db, {});
  const model = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-modele-0', displayName: 'Modèle' });
  const test1 = await call('POST', '/api/tests', admin, {
    name: 'T',
    category: 'Culture',
    userPrompt: 'Salut',
    scoringMethod: 'manual',
    scoringConfig: {},
  });
  const run = await call('POST', '/api/runs', admin, { name: 'Série', testIds: [test1.json().test.id], modelIds: [model.id] });
  expect(run.statusCode).toBe(201);
  const [result] = await t.db.select().from(results).where(eq(results.runId, run.json().run.id as string));
  return {
    ...t,
    admin,
    user,
    adminRow,
    userRow,
    result: result!,
    override: (id: string, score: unknown, s = admin) => call('PUT', `/api/scoring/results/${id}/override`, s, { score }),
  };
}

test('note imposée : 0 à 10, une décimale ; retirée par null ; audit ; résultat non terminé → 409', async () => {
  const s = await setup();
  // Résultat encore en attente : refusé.
  let res = await s.override(s.result.id, 5);
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe('result_not_scorable');

  await s.db.update(results).set({ status: 'done' }).where(eq(results.id, s.result.id));
  res = await s.override(s.result.id, 7.5);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ result: { id: s.result.id, overrideScore: 7.5, overrideBy: s.adminRow.id } });
  let [row] = await s.db.select().from(results).where(eq(results.id, s.result.id));
  expect(row).toMatchObject({ overrideScore: 7.5, overrideBy: s.adminRow.id });

  // Bornes incluses.
  expect((await s.override(s.result.id, 0)).json().result.overrideScore).toBe(0);
  expect((await s.override(s.result.id, 10)).json().result.overrideScore).toBe(10);

  for (const bad of [-0.1, 10.1, 3.25, 'a', undefined]) {
    res = await s.override(s.result.id, bad);
    expect(res.statusCode, String(bad)).toBe(400);
  }

  res = await s.override(s.result.id, null);
  expect(res.json()).toEqual({ result: { id: s.result.id, overrideScore: null, overrideBy: null } });
  [row] = await s.db.select().from(results).where(eq(results.id, s.result.id));
  expect(row).toMatchObject({ overrideScore: null, overrideBy: null });

  const audits = await s.db.select().from(auditLog).where(eq(auditLog.action, 'score_overridden'));
  expect(audits).toHaveLength(4); // 7,5 ; 0 ; 10 ; retrait
  expect(audits[0]).toMatchObject({ actorUserId: s.adminRow.id, targetType: 'result', targetId: s.result.id });

  expect((await s.override(randomUUID(), 5)).statusCode).toBe(404);
  expect((await s.override(s.result.id, 5, s.user)).statusCode).toBe(403);
});

test('migration 0004 : manual_scores unique par résultat et compte, supprimée avec le résultat', async () => {
  const s = await setup();
  await s.db.insert(manualScores).values({ id: randomUUID(), resultId: s.result.id, userId: s.userRow.id, score: 8 });
  await expect(
    s.db.insert(manualScores).values({ id: randomUUID(), resultId: s.result.id, userId: s.userRow.id, score: 4, comment: 'bis' }),
  ).rejects.toThrow();
  // Un autre compte peut noter le même résultat.
  await s.db.insert(manualScores).values({ id: randomUUID(), resultId: s.result.id, userId: s.adminRow.id, score: 6 });
  expect(await s.db.select().from(manualScores)).toHaveLength(2);
  await s.db.delete(results).where(eq(results.id, s.result.id));
  expect(await s.db.select().from(manualScores)).toHaveLength(0);
});
