import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { manualScores, results, runModels, runTests, runs } from '../src/db/schema/runs.js';
import { shareLinks } from '../src/db/schema/sharing.js';
import { buildTestApp, loginAs, seedModel, seedProvider, seedUser, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const NOT_FOUND = { error: { code: 'not_found', message: 'Lien introuvable ou désactivé' } };
const created: TestApp[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

/**
 * Série terminée : un test à réponse attendue (Culture) et un test manuel (Écriture), modèles A et B, un juge.
 * A : exact (10) ; B : faux (0). Notes manuelles sur « Rédaction » : A par l'Admin 8 et l'Utilisateur 4 (moyenne 6), B 6 par l'Admin.
 * Coûts de la série : 0,5 $ de modèles et 0,25 $ de juge.
 */
async function setup() {
  const t = await buildTestApp({ fakeLlm: true });
  created.push(t);
  const adminRow = await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin', name: 'Alice Admin' });
  const userRow = await seedUser(t.db, { email: 'user@acme.fr', role: 'user', name: 'Ulysse Util' });
  const admin = await loginAs(t.app, 'admin@acme.fr', PW);
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  const provider = await seedProvider(t.db, { name: 'Fournisseur Alpha' });
  const mA = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-a', displayName: 'Modèle A', color: '#aa0001' });
  const mB = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-b', displayName: 'Modèle B', color: '#aa0002' });
  const judge = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-juge', displayName: 'Juge', color: '#aa0003' });
  const expectedTest = await call('POST', '/api/tests', {
    name: 'Capitale',
    category: 'Culture',
    userPrompt: 'Capitale de la France ?',
    scoringMethod: 'expected',
    scoringConfig: { mode: 'exact', expected: 'Paris' },
  });
  const manualTest = await call('POST', '/api/tests', {
    name: 'Rédaction',
    category: 'Écriture',
    userPrompt: 'Écris un haïku',
    scoringMethod: 'manual',
    scoringConfig: {},
  });
  const run = await call('POST', '/api/runs', {
    name: 'Polyvalence d’octobre',
    testIds: [expectedTest.json().test.id, manualTest.json().test.id],
    modelIds: [mA.id, mB.id],
    repetitions: 1,
    judgeModelId: judge.id,
  });
  expect(run.statusCode).toBe(201);
  const runId = run.json().run.id as string;
  const [rtExpected, rtManual] = await t.db.select().from(runTests).where(eq(runTests.runId, runId)).orderBy(asc(runTests.position));
  const resultOf = async (runTestId: string, modelId: string) => {
    const [r] = await t.db.select().from(results).where(and(eq(results.runTestId, runTestId), eq(results.modelId, modelId)));
    return r!.id;
  };
  const ids = {
    expA: await resultOf(rtExpected!.id, mA.id),
    expB: await resultOf(rtExpected!.id, mB.id),
    manA: await resultOf(rtManual!.id, mA.id),
    manB: await resultOf(rtManual!.id, mB.id),
  };
  const done = { status: 'done' as const, attempts: 1, finishReason: 'stop', inputTokens: 10, completedAt: new Date('2026-01-15T10:00:00.000Z'), scoreStatus: 'done' as const };
  const set = (id: string, values: Partial<typeof results.$inferInsert>) => t.db.update(results).set({ ...done, ...values }).where(eq(results.id, id));
  await set(ids.expA, { responseText: 'Paris', ttftMs: 100, totalMs: 900, tokensPerS: 50, outputTokens: 20, costUsd: 0.002, autoScore: 10, judgeRationale: 'Réponse exacte', judgeCostUsd: 0.5 });
  await set(ids.expB, { responseText: 'Lyon', ttftMs: 200, totalMs: 1200, tokensPerS: 100, outputTokens: 30, costUsd: 0.004, autoScore: 0, judgeRationale: 'Réponse différente' });
  await set(ids.manA, { responseText: 'Haïku de A', ttftMs: 100, totalMs: 800, tokensPerS: 50, outputTokens: 40, costUsd: 0.001 });
  await set(ids.manB, { responseText: 'Haïku de B', ttftMs: 200, totalMs: 1500, tokensPerS: 100, outputTokens: 45, costUsd: 0.002 });
  const rate = (resultId: string, userId: string, score: number) => t.db.insert(manualScores).values({ id: randomUUID(), resultId, userId, score });
  await rate(ids.manA, adminRow.id, 8);
  await rate(ids.manA, userRow.id, 4);
  await rate(ids.manB, adminRow.id, 6);
  await t.db.update(runs).set({ status: 'completed', completedAt: new Date('2026-01-15T11:00:00.000Z'), modelsCostUsd: 0.5, judgeCostUsd: 0.25 }).where(eq(runs.id, runId));

  const body = (over: Record<string, unknown> = {}) => ({
    runId,
    title: 'Comparatif d’octobre',
    intro: 'Introduction publique',
    verdicts: [
      { label: 'Meilleur choix', modelId: mA.id, text: 'Le plus juste.' },
      { label: 'Remarque générale', modelId: null, text: 'Deux modèles comparés.' },
    ],
    showCosts: false,
    showResponses: false,
    ...over,
  });
  /** Crée un lien et renvoie son jeton en clair. */
  const create = async (over: Record<string, unknown> = {}) => {
    const res = await call('POST', '/api/share-links', body(over));
    expect(res.statusCode).toBe(201);
    return { token: res.json().token as string, id: res.json().link.id as string };
  };
  const pub = (token: string) => t.app.inject({ method: 'GET', url: `/share/${token}` });
  return { t, call, runId, mA, mB, ids, create, pub };
}

test('lien actif : 200 sans session ; clés de premier niveau exactement celles de PublicShare ; aucun UUID dans le JSON', async () => {
  const s = await setup();
  const { token } = await s.create();
  const res = await s.pub(token);
  expect(res.statusCode).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  const json = res.json();
  expect(Object.keys(json).sort()).toEqual(['auditUrl', 'categories', 'intro', 'models', 'responses', 'run', 'showCosts', 'title', 'verdicts', 'weights']);
  expect(Object.keys(json.run).sort()).toEqual(['completedAt', 'judgeName', 'modelCount', 'name', 'repetitions', 'testCount', 'totalCostUsd']);
  expect(Object.keys(json.models[0]).sort()).toEqual(['byCategory', 'color', 'cost', 'modelId', 'name', 'providerName', 'quality', 'raw', 'reliability', 'speed']);
  expect(Object.keys(json.models[0].raw).sort()).toEqual(['done', 'failed', 'meanCostUsd', 'medianTokensPerS', 'medianTtftMs', 'scoredTests', 'unsupported']);
  expect(Object.keys(json.verdicts[0]).sort()).toEqual(['label', 'model', 'text']);
  expect(Object.keys(json.verdicts[0].model).sort()).toEqual(['color', 'key', 'name']);
  expect(JSON.stringify(json)).not.toMatch(UUID_RE);
  expect(res.body).not.toContain(s.mA.id);

  expect(json).toMatchObject({
    title: 'Comparatif d’octobre',
    intro: 'Introduction publique',
    auditUrl: 'https://eksplodo.fr',
    showCosts: false,
    run: { name: 'Polyvalence d’octobre', completedAt: '2026-01-15T11:00:00.000Z', modelCount: 2, testCount: 2, repetitions: 1, judgeName: 'Juge' },
    categories: ['Culture', 'Écriture'],
  });
  // A (qualité 8) devant B (qualité 3) : clés dans l'ordre du classement.
  expect(json.models.map((m: { modelId: string; name: string }) => [m.modelId, m.name])).toEqual([
    ['m1', 'Modèle A'],
    ['m2', 'Modèle B'],
  ]);
  expect(json.verdicts[0].model).toEqual({ key: 'm1', name: 'Modèle A', color: '#aa0001' });
  expect(json.verdicts[1].model).toBeNull();
});

test('show_costs faux : aucun montant ni note de coût ; vrai : montants présents', async () => {
  const s = await setup();
  const hidden = (await s.pub((await s.create({ showCosts: false })).token)).json();
  expect(hidden.showCosts).toBe(false);
  expect(hidden.run.totalCostUsd).toBeNull();
  for (const m of hidden.models) {
    expect(m.cost).toBeNull();
    expect(m.raw.meanCostUsd).toBeNull();
  }
  const shown = (await s.pub((await s.create({ showCosts: true })).token)).json();
  expect(shown.showCosts).toBe(true);
  expect(shown.run.totalCostUsd).toBeCloseTo(0.75, 6);
  expect(shown.models[0].raw.meanCostUsd).not.toBeNull();
  expect(shown.models.some((m: { cost: number | null }) => m.cost !== null)).toBe(true);
});

test('show_responses faux : responses null ; vrai : textes des réponses réussies, sans évaluateur, commentaire ni coût', async () => {
  const s = await setup();
  expect((await s.pub((await s.create({ showResponses: false })).token)).json().responses).toBeNull();

  // Une réponse en erreur n'est pas publiée.
  await s.t.db.update(results).set({ status: 'error', responseText: 'secret interne' }).where(eq(results.id, s.ids.expB));
  const res = await s.pub((await s.create({ showResponses: true })).token);
  const { responses } = res.json();
  expect(responses).toHaveLength(2);
  expect(Object.keys(responses[0]).sort()).toEqual(['answers', 'category', 'testName', 'userPrompt']);
  expect(responses[0]).toMatchObject({ testName: 'Capitale', category: 'Culture', userPrompt: 'Capitale de la France ?' });
  expect(responses[0].answers).toEqual([{ modelKey: 'm1', repetition: 1, text: 'Paris', finalScore: 10, judgeRationale: 'Réponse exacte' }]);
  expect(responses[1].answers.map((a: { modelKey: string; text: string }) => [a.modelKey, a.text])).toEqual([
    ['m1', 'Haïku de A'],
    ['m2', 'Haïku de B'],
  ]);
  for (const a of responses[1].answers) expect(Object.keys(a).sort()).toEqual(['finalScore', 'judgeRationale', 'modelKey', 'repetition', 'text']);
  expect(res.body).not.toContain('secret interne');
  expect(res.body).not.toMatch(UUID_RE);
});

test('notes manuelles : seule la moyenne agrégée apparaît, jamais une note individuelle ni un nom d’évaluateur', async () => {
  const s = await setup();
  const res = await s.pub((await s.create({ showResponses: true })).token);
  const json = res.json();
  // Moyenne de A sur « Rédaction » : (8 + 4) / 2 = 6 ; qualité de A : (10 + 6) / 2 = 8.
  const manual = json.responses[1].answers.find((a: { modelKey: string }) => a.modelKey === 'm1');
  expect(manual.finalScore).toBe(6);
  expect(json.models[0].quality).toBe(8);
  expect(json.models[0].byCategory).toEqual({ Culture: 10, Écriture: 6 });
  for (const hidden of ['Alice', 'Ulysse', 'admin@acme.fr', 'user@acme.fr', 'manualScores', 'userId', 'evaluator']) expect(res.body).not.toContain(hidden);
});

test('lien désactivé, inconnu ou ancien jeton après régénération → 404 avec le même message', async () => {
  const s = await setup();
  const { token, id } = await s.create();
  expect((await s.pub(token)).statusCode).toBe(200);

  const unknown = await s.pub('x'.repeat(32));
  expect(unknown.statusCode).toBe(404);
  expect(unknown.json()).toEqual(NOT_FOUND);

  const regen = await s.call('POST', `/api/share-links/${id}/regenerate`);
  const fresh = regen.json().token as string;
  const old = await s.pub(token);
  expect(old.statusCode).toBe(404);
  expect(old.json()).toEqual(NOT_FOUND);
  expect((await s.pub(fresh)).statusCode).toBe(200);

  await s.t.db.update(shareLinks).set({ active: false }).where(eq(shareLinks.id, id));
  const off = await s.pub(fresh);
  expect(off.statusCode).toBe(404);
  expect(off.json()).toEqual(NOT_FOUND);
});

test('chaque consultation incrémente view_count ; 61e requête de la minute → 429', async () => {
  const s = await setup();
  const { token, id } = await s.create();
  for (let i = 0; i < 3; i++) expect((await s.pub(token)).statusCode).toBe(200);
  const [row] = await s.t.db.select({ n: shareLinks.viewCount }).from(shareLinks).where(eq(shareLinks.id, id));
  expect(row?.n).toBe(3);
  // Un lien inconnu ne compte pas, mais consomme la limite par IP.
  expect((await s.pub('inconnu')).statusCode).toBe(404);
  const [after] = await s.t.db.select({ n: shareLinks.viewCount }).from(shareLinks).where(eq(shareLinks.id, id));
  expect(after?.n).toBe(3);

  // 4 requêtes déjà faites : les 56 suivantes passent, la 61e est refusée.
  for (let i = 0; i < 56; i++) expect((await s.pub('inconnu')).statusCode).toBe(404);
  const limited = await s.pub(token);
  expect(limited.statusCode).toBe(429);
  expect(limited.json().error.code).toBe('rate_limited');
});

test('verdict dont le modèle a été retiré : model null, sans erreur', async () => {
  const s = await setup();
  const { token } = await s.create();
  await s.t.db.delete(runModels).where(and(eq(runModels.runId, s.runId), eq(runModels.modelId, s.mA.id)));
  const res = await s.pub(token);
  expect(res.statusCode).toBe(200);
  const json = res.json();
  expect(json.verdicts[0].model).toBeNull();
  expect(json.models.map((m: { name: string }) => m.name)).toEqual(['Modèle B']);
  expect(json.models[0].modelId).toBe('m1');
});
