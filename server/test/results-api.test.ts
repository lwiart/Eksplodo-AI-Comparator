import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, expect, test } from 'vitest';
import { manualScores, results, runTests } from '../src/db/schema/runs.js';
import { buildTestApp, loginAs, seedModel, seedProvider, seedUser, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const created: TestApp[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

/**
 * Série « Polyvalence d’octobre » : un test à réponse attendue (Culture) et un test manuel (Écriture), modèles A et B,
 * une répétition, juge déclaré. Tous les résultats sont terminés : A répond juste (10), B faux (0) avec une formule ;
 * notes manuelles de l'Admin : A 8, B 6. Le juge a coûté 0,5 $ sur le résultat de A (jamais imputé au modèle).
 */
async function setup(opts: { dataDir?: string } = {}) {
  const t = await buildTestApp({ fakeLlm: true, ...opts });
  created.push(t);
  const adminRow = await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin', name: 'Alice Admin' });
  const userRow = await seedUser(t.db, { email: 'user@acme.fr', role: 'user', name: 'Ulysse Util' });
  const admin = await loginAs(t.app, 'admin@acme.fr', PW);
  const user = await loginAs(t.app, 'user@acme.fr', PW);
  type Session = typeof admin;
  const call = (method: 'GET' | 'POST', url: string, s: Session | null, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: s === null ? {} : { cookie: s.cookie, 'x-csrf-token': s.csrf },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const get = (url: string, s: Session | null = admin) => call('GET', url, s);

  const provider = await seedProvider(t.db, { name: 'Fournisseur Alpha' });
  const mA = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-a', displayName: 'Modèle A', color: '#aa0001' });
  const mB = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-b', displayName: 'Modèle B', color: '#aa0002' });
  const judge = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-juge', displayName: 'Juge', color: '#aa0003' });
  const expectedTest = await call('POST', '/api/tests', admin, {
    name: 'Capitale',
    category: 'Culture',
    userPrompt: 'Capitale de la France ?',
    scoringMethod: 'expected',
    scoringConfig: { mode: 'exact', expected: 'Paris' },
  });
  const manualTest = await call('POST', '/api/tests', admin, {
    name: 'Rédaction',
    category: 'Écriture',
    userPrompt: 'Écris un haïku',
    scoringMethod: 'manual',
    scoringConfig: {},
  });
  const run = await call('POST', '/api/runs', admin, {
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
  const done = { status: 'done' as const, attempts: 1, finishReason: 'stop', inputTokens: 10, completedAt: new Date('2026-01-15T10:00:00.000Z') };
  await t.db
    .update(results)
    .set({ ...done, responseText: 'Paris', ttftMs: 100, totalMs: 900, tokensPerS: 50, outputTokens: 20, reasoningTokens: 4, costUsd: 0.002, scoreStatus: 'done', autoScore: 10, judgeRationale: 'Réponse exacte', judgeCostUsd: 0.5 })
    .where(eq(results.id, ids.expA));
  await t.db
    .update(results)
    .set({ ...done, responseText: '=SOMME(A1:A2)', ttftMs: 200, totalMs: 1200, tokensPerS: 100, outputTokens: 30, costUsd: 0.004, scoreStatus: 'done', autoScore: 0, judgeRationale: 'Réponse différente' })
    .where(eq(results.id, ids.expB));
  await t.db
    .update(results)
    .set({ ...done, responseText: 'Haïku de A\nsur deux lignes', ttftMs: 100, totalMs: 800, tokensPerS: 50, outputTokens: 40, costUsd: 0.001, scoreStatus: 'done' })
    .where(eq(results.id, ids.manA));
  await t.db
    .update(results)
    .set({ ...done, responseText: 'Haïku de B', ttftMs: 200, totalMs: 1500, tokensPerS: 100, outputTokens: 45, costUsd: 0.002, scoreStatus: 'done' })
    .where(eq(results.id, ids.manB));
  const rate = (resultId: string, userId: string, score: number) =>
    t.db.insert(manualScores).values({ id: randomUUID(), resultId, userId, score });
  await rate(ids.manA, adminRow.id, 8);
  await rate(ids.manB, adminRow.id, 6);

  /** Seconde série sur les mêmes tests et modèles : tous ses résultats restent en attente. */
  const createOtherRun = async () => {
    const res = await call('POST', '/api/runs', admin, {
      name: 'Autre série',
      testIds: [expectedTest.json().test.id, manualTest.json().test.id],
      modelIds: [mA.id, mB.id],
      repetitions: 1,
    });
    expect(res.statusCode).toBe(201);
    const otherRunId = res.json().run.id as string;
    const rts = await t.db.select().from(runTests).where(eq(runTests.runId, otherRunId)).orderBy(asc(runTests.position));
    return { otherRunId, otherRt: rts[0]!.id };
  };

  return { t, admin, user, get, runId, rtExpected: rtExpected!.id, rtManual: rtManual!.id, ids, mA, mB, userRow, rate, createOtherRun };
}

test('API ranking et answers ; Utilisateur : réponses manuelles masquées tant que la question n’est pas notée', async () => {
  const { admin, user, get, runId, rtExpected, rtManual, ids, mA, mB, userRow, rate, createOtherRun } = await setup();

  // Classement de l'Admin : toutes les notes ; modèles du meilleur au moins bon (pondération de la série).
  const ranking = await get(`/api/runs/${runId}/ranking`, admin);
  expect(ranking.statusCode).toBe(200);
  const body = ranking.json();
  expect(body.weights).toEqual({ quality: 50, speed: 20, cost: 20, reliability: 10 });
  expect(body.categories).toEqual(['Culture', 'Écriture']);
  expect(body.judge).toEqual({ modelName: 'Juge' });
  expect(body.models).toHaveLength(2);
  // A : qualité (10 + 8) / 2 = 9 ; premier token 100 ms et débit 50 (médianes) ; coût moyen 0,0015 $ (le juge exclu).
  expect(body.models[0]).toEqual({
    modelId: mA.id,
    name: 'Modèle A',
    color: '#aa0001',
    providerName: 'Fournisseur Alpha',
    quality: 9,
    speed: 6,
    cost: 10,
    reliability: 10,
    raw: { medianTtftMs: 100, medianTokensPerS: 50, meanCostUsd: 0.0015, done: 2, failed: 0, unsupported: 0, scoredTests: 2 },
    byCategory: { Culture: 10, Écriture: 8 },
  });
  // B : qualité (0 + 6) / 2 = 3 ; coût moyen 0,003 $ (le double de A) → 2.
  expect(body.models[1]).toMatchObject({ modelId: mB.id, name: 'Modèle B', quality: 3, speed: 6, cost: 2, reliability: 10, byCategory: { Culture: 0, Écriture: 6 } });

  // Réponses côte à côte d'un test à réponse attendue : visibles, avec notes et justification du juge.
  const expected = await get(`/api/runs/${runId}/answers/${rtExpected}`, user);
  expect(expected.statusCode).toBe(200);
  expect(expected.json().test).toEqual({ name: 'Capitale', category: 'Culture', userPrompt: 'Capitale de la France ?', scoringMethod: 'expected', attachments: [] });
  expect(expected.json().answers).toEqual([
    {
      resultId: ids.expA,
      modelName: 'Modèle A',
      color: '#aa0001',
      repetition: 1,
      status: 'done',
      responseText: 'Paris',
      hiddenUntilScored: false,
      finalScore: 10,
      autoScore: 10,
      manualAvg: null,
      overrideScore: null,
      judgeRationale: 'Réponse exacte',
      ttftMs: 100,
      tokensPerS: 50,
      costUsd: 0.002,
      errorMessage: null,
    },
    expect.objectContaining({ resultId: ids.expB, modelName: 'Modèle B', responseText: '=SOMME(A1:A2)', finalScore: 0 }),
  ]);

  // Test manuel non noté par l'Utilisateur : ni texte, ni métrique, ni note (celles des autres évaluateurs orienteraient
  // sa notation à l'aveugle) ; l'Admin voit tout.
  const hiddenAnswer = (resultId: string, modelName: string, color: string) => ({
    resultId,
    modelName,
    color,
    repetition: 1,
    status: 'done',
    responseText: null,
    hiddenUntilScored: true,
    finalScore: null,
    autoScore: null,
    manualAvg: null,
    overrideScore: null,
    judgeRationale: null,
    ttftMs: null,
    tokensPerS: null,
    costUsd: null,
    errorMessage: null,
  });
  const hidden = await get(`/api/runs/${runId}/answers/${rtManual}`, user);
  expect(hidden.json().test.scoringMethod).toBe('manual');
  expect(hidden.json().answers).toEqual([hiddenAnswer(ids.manA, 'Modèle A', '#aa0001'), hiddenAnswer(ids.manB, 'Modèle B', '#aa0002')]);
  const asAdmin = await get(`/api/runs/${runId}/answers/${rtManual}`, admin);
  expect(asAdmin.json().answers[0]).toMatchObject({
    responseText: 'Haïku de A\nsur deux lignes',
    hiddenUntilScored: false,
    ttftMs: 100,
    costUsd: 0.001,
    manualAvg: 8,
    finalScore: 8,
  });

  // Une fois la question notée par l'Utilisateur : réponses visibles, moyenne des deux évaluateurs.
  await rate(ids.manA, userRow.id, 4);
  await rate(ids.manB, userRow.id, 7);
  const visible = await get(`/api/runs/${runId}/answers/${rtManual}`, user);
  expect(visible.json().answers).toEqual([
    expect.objectContaining({ responseText: 'Haïku de A\nsur deux lignes', hiddenUntilScored: false, manualAvg: 6, finalScore: 6, autoScore: null }),
    expect.objectContaining({ responseText: 'Haïku de B', hiddenUntilScored: false, manualAvg: 6.5, finalScore: 6.5 }),
  ]);
  // Son classement compte alors la question manuelle, comme celui de l'Admin.
  expect((await get(`/api/runs/${runId}/ranking`, user)).json()).toEqual((await get(`/api/runs/${runId}/ranking`, admin)).json());

  // Introuvables : série inconnue, test d'une autre série ; non connecté : 401.
  expect((await get(`/api/runs/${randomUUID()}/ranking`)).statusCode).toBe(404);
  expect((await get(`/api/runs/${randomUUID()}/answers/${rtExpected}`)).statusCode).toBe(404);
  expect((await get(`/api/runs/${runId}/answers/${randomUUID()}`)).statusCode).toBe(404);
  // Test bien réel, mais d'une autre série, demandé par l'identifiant de la première.
  const { otherRunId, otherRt } = await createOtherRun();
  expect((await get(`/api/runs/${otherRunId}/answers/${otherRt}`)).statusCode).toBe(200);
  expect((await get(`/api/runs/${runId}/answers/${otherRt}`)).statusCode).toBe(404);
  expect((await get(`/api/runs/${runId}/ranking`, null)).statusCode).toBe(401);
  expect((await get(`/api/runs/${runId}/answers/${rtExpected}`, null)).statusCode).toBe(401);
  expect((await get(`/api/runs/${runId}/export.csv`, null)).statusCode).toBe(401);
});

test('classement : notes d’une question manuelle non notée retirées pour l’Utilisateur (moyenne et note imposée), visibles après notation', async () => {
  const { t, admin, user, get, runId, ids, mA, mB, userRow, rate } = await setup();
  // Note imposée sur une réponse manuelle : elle aussi orienterait la notation à l'aveugle.
  await t.db.update(results).set({ overrideScore: 1 }).where(eq(results.id, ids.manB));
  const asAdmin = (await get(`/api/runs/${runId}/ranking`, admin)).json();
  expect(asAdmin.models.find((m: { modelId: string }) => m.modelId === mB.id)).toMatchObject({ byCategory: { Culture: 0, Écriture: 1 } });

  // Utilisateur qui n'a pas noté la question : test manuel non noté pour lui (qualité sur le seul test à réponse attendue).
  const before = (await get(`/api/runs/${runId}/ranking`, user)).json();
  expect(before.models).toEqual([
    expect.objectContaining({ modelId: mA.id, quality: 10, byCategory: { Culture: 10, Écriture: null }, raw: expect.objectContaining({ scoredTests: 1 }) }),
    expect.objectContaining({ modelId: mB.id, quality: 0, byCategory: { Culture: 0, Écriture: null }, raw: expect.objectContaining({ scoredTests: 1 }) }),
  ]);

  // Après sa notation : moyenne des deux évaluateurs pour A ((8 + 4) / 2 = 6), note imposée pour B.
  await rate(ids.manA, userRow.id, 4);
  await rate(ids.manB, userRow.id, 7);
  const after = (await get(`/api/runs/${runId}/ranking`, user)).json();
  expect(after.models.find((m: { modelId: string }) => m.modelId === mA.id)).toMatchObject({ quality: 8, byCategory: { Culture: 10, Écriture: 6 } });
  expect(after.models.find((m: { modelId: string }) => m.modelId === mB.id)).toMatchObject({ byCategory: { Culture: 0, Écriture: 1 } });
  expect(after).toEqual((await get(`/api/runs/${runId}/ranking`, admin)).json());
});

test('le coût du juge n’entre jamais dans le coût moyen du modèle', async () => {
  const { t, get, runId, ids, mA } = await setup();
  await t.db.update(results).set({ judgeCostUsd: 3 }).where(eq(results.id, ids.manA));
  const models = (await get(`/api/runs/${runId}/ranking`)).json().models as { modelId: string; raw: { meanCostUsd: number } }[];
  // (0,002 + 0,001) / 2 = 0,0015 $ : seuls les coûts des réponses du modèle.
  expect(models.find((m) => m.modelId === mA.id)!.raw.meanCostUsd).toBe(0.0015);
});

test('série sans résultat terminé : classement sans note, modèles dans l’ordre d’ajout', async () => {
  const { get, mA, mB, createOtherRun } = await setup();
  const { otherRunId } = await createOtherRun();
  const body = (await get(`/api/runs/${otherRunId}/ranking`)).json();
  expect(body.categories).toEqual(['Culture', 'Écriture']);
  expect(body.judge).toBeNull();
  const empty = {
    quality: null,
    speed: null,
    cost: null,
    reliability: null,
    raw: { medianTtftMs: null, medianTokensPerS: null, meanCostUsd: null, done: 0, failed: 0, unsupported: 0, scoredTests: 0 },
    byCategory: { Culture: null, Écriture: null },
  };
  expect(body.models).toEqual([
    { modelId: mA.id, name: 'Modèle A', color: '#aa0001', providerName: 'Fournisseur Alpha', ...empty },
    { modelId: mB.id, name: 'Modèle B', color: '#aa0002', providerName: 'Fournisseur Alpha', ...empty },
  ]);
});

test('note imposée prioritaire, modèle sans test noté classé hors podium', async () => {
  const { t, get, runId, ids, mA, mB } = await setup();
  // B : plus aucune note (résultats en échec) → qualité nulle ; A : note imposée 2 sur le test à réponse attendue.
  await t.db.update(results).set({ status: 'error', scoreStatus: 'pending', autoScore: null, errorMessage: 'Délai' }).where(eq(results.id, ids.expB));
  await t.db.delete(manualScores).where(eq(manualScores.resultId, ids.manB));
  await t.db.update(results).set({ scoreStatus: 'awaiting_manual' }).where(eq(results.id, ids.manB));
  await t.db.update(results).set({ overrideScore: 2 }).where(eq(results.id, ids.expA));
  const body = (await get(`/api/runs/${runId}/ranking`)).json();
  expect(body.models.map((m: { modelId: string }) => m.modelId)).toEqual([mA.id, mB.id]);
  expect(body.models[0]).toMatchObject({ quality: 5, raw: { scoredTests: 2 } });
  expect(body.models[1]).toMatchObject({ quality: null, reliability: 5, raw: { done: 1, failed: 1, scoredTests: 0 }, byCategory: { Culture: null, Écriture: null } });
});

test('export CSV : en-têtes, une ligne par résultat, réponses masquées pour l’Utilisateur, formules neutralisées', async () => {
  const { admin, user, get, runId, ids, userRow, rate } = await setup();
  expect((await get(`/api/runs/${randomUUID()}/export.csv`)).statusCode).toBe(404);

  const csv = await get(`/api/runs/${runId}/export.csv`, user);
  expect(csv.statusCode).toBe(200);
  expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
  expect(csv.headers['content-disposition']).toBe(
    'attachment; filename="serie-polyvalence-d-octobre.csv"; filename*=UTF-8\'\'serie-polyvalence-d-octobre.csv',
  );
  const text = csv.body;
  expect(text.startsWith('\uFEFF')).toBe(true);
  const lines = text.slice(1).split('\r\n');
  expect(lines[0]).toBe(
    'série;test;catégorie;modèle;répétition;statut;note finale;note auto;note manuelle (moyenne);note imposée;premier token (ms);durée (ms);tokens/s;tokens entrée;tokens sortie;raisonnement;coût ($);coût du juge ($);erreur;réponse',
  );
  const manual = 'Polyvalence d’octobre;Rédaction;Écriture';
  expect(lines.slice(1)).toEqual([
    'Polyvalence d’octobre;Capitale;Culture;Modèle A;1;réussi;10;10;;;100;900;50;10;20;4;0,002;0,5;;Paris',
    "Polyvalence d’octobre;Capitale;Culture;Modèle B;1;réussi;0;0;;;200;1200;100;10;30;;0,004;;;'=SOMME(A1:A2)",
    // Question manuelle non notée par l'Utilisateur : ni note, ni métrique, ni texte (13 cellules vides, puis la mention).
    `${manual};Modèle A;1;réussi${';'.repeat(14)}(masquée jusqu'à notation)`,
    `${manual};Modèle B;1;réussi${';'.repeat(14)}(masquée jusqu'à notation)`,
    '',
  ]);

  // L'Admin reçoit notes, texte et métriques, retour à la ligne entre guillemets.
  const adminCsv = (await get(`/api/runs/${runId}/export.csv`, admin)).body;
  expect(adminCsv).toContain(`${manual};Modèle A;1;réussi;8;;8;;100;800;50;10;40;;0,001;;;"Haïku de A\nsur deux lignes"\r\n`);

  // Une fois la question notée par l'Utilisateur : notes (moyenne des deux évaluateurs), métriques et texte.
  await rate(ids.manA, userRow.id, 4);
  await rate(ids.manB, userRow.id, 7);
  const scored = (await get(`/api/runs/${runId}/export.csv`, user)).body;
  expect(scored).toContain(`${manual};Modèle A;1;réussi;6;;6;;100;800;50;10;40;;0,001;;;"Haïku de A\nsur deux lignes"\r\n`);
  expect(scored).toContain(`${manual};Modèle B;1;réussi;6,5;;6,5;;200;1500;100;10;45;;0,002;;;Haïku de B\r\n`);
});

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

test('pièces jointes des réponses côte à côte : liste dans answers, fichier en attachment ou inline, mêmes droits', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aic-results-'));
  dirs.push(dataDir);
  const { t, get, user, runId, rtManual, createOtherRun } = await setup({ dataDir });
  await mkdir(path.join(dataDir, 'attachments', 'figee'), { recursive: true });
  await writeFile(path.join(dataDir, 'attachments/figee/img'), Buffer.from('PNG-octets'));
  await writeFile(path.join(dataDir, 'attachments/figee/doc'), Buffer.from('%PDF-1.4 contenu'));
  const [rt] = await t.db.select().from(runTests).where(eq(runTests.id, rtManual));
  const base = { size: 10, sha256: 'x' };
  await t.db
    .update(runTests)
    .set({
      snapshot: {
        ...rt!.snapshot,
        attachments: [
          { ...base, id: randomUUID(), originalName: 'schéma.png', mime: 'image/png', pages: null, storagePath: 'attachments/figee/img' },
          { ...base, id: randomUUID(), originalName: 'énoncé.pdf', mime: 'application/pdf', pages: 3, storagePath: 'attachments/figee/doc' },
          { ...base, id: randomUUID(), originalName: 'perdu.png', mime: 'image/png', pages: null, storagePath: 'attachments/figee/absent' },
        ],
      },
    })
    .where(eq(runTests.id, rtManual));

  // Liste : position, nom, type et pages ; ni identifiant ni chemin de stockage.
  const answers = await get(`/api/runs/${runId}/answers/${rtManual}`, user);
  expect(answers.json().test.attachments).toEqual([
    { index: 0, originalName: 'schéma.png', mime: 'image/png', pages: null },
    { index: 1, originalName: 'énoncé.pdf', mime: 'application/pdf', pages: 3 },
    { index: 2, originalName: 'perdu.png', mime: 'image/png', pages: null },
  ]);
  expect(answers.body).not.toContain('figee');

  const url = (i: number | string) => `/api/runs/${runId}/answers/${rtManual}/attachments/${i}`;
  const file = await get(url(0), user);
  expect(file.statusCode).toBe(200);
  expect(file.body).toBe('PNG-octets');
  expect(file.headers['content-type']).toBe('image/png');
  expect(file.headers['content-disposition']).toMatch(/^attachment; filename="sch_ma.png"/);
  expect(file.headers['x-content-type-options']).toBe('nosniff');
  expect(file.headers['cache-control']).toBe('private, no-store');
  const pdf = await get(`${url(1)}?inline=1`, user);
  expect(pdf.statusCode).toBe(200);
  expect(pdf.headers['content-type']).toBe('application/pdf');
  expect(pdf.headers['content-disposition']).toMatch(/^inline; filename="_nonc_.pdf"/);
  expect(pdf.headers['x-content-type-options']).toBe('nosniff');
  expect(pdf.headers['cache-control']).toBe('private, no-store');

  // Introuvable : position hors liste, fichier absent, test d'une autre série ; sans session : 401.
  expect((await get(url(3), user)).statusCode).toBe(404);
  expect((await get(url(2), user)).statusCode).toBe(404);
  expect((await get(url('x'), user)).statusCode).toBe(400);
  const { otherRunId } = await createOtherRun();
  expect((await get(`/api/runs/${otherRunId}/answers/${rtManual}/attachments/0`, user)).statusCode).toBe(404);
  expect((await get(url(0), null)).statusCode).toBe(401);
});
