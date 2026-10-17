import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { manualScores, results, runTests } from '../src/db/schema/runs.js';
import { blindOrder, blindOrderKey, letterOf } from '../src/modules/scoring/manual.service.js';
import { buildTestApp, loginAs, seedModel, seedProvider, seedUser, testConfig, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-/;
const created: TestApp[] = [];
/** Clé de l'ordre à l'aveugle de l'application de test (dérivée de la clé maîtresse de `testConfig`). */
const KEY = blindOrderKey(testConfig().encryptionKey);

/** Ordres non secrets qu'un compte pourrait recalculer : `sha256(userId + resultId)` et `sha256(userId:resultId)`. */
const unkeyedOrder = (userId: string, ids: string[], sep = '') =>
  ids
    .map((id) => ({ id, h: createHash('sha256').update(userId + sep + id).digest('hex') }))
    .sort((a, b) => (a.h < b.h ? -1 : 1))
    .map((x) => x.id);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}, 60_000);

test('letterOf : A…Z puis AA, AB…', () => {
  expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(letterOf)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
});

test('ordre stable pour un compte, différent pour un autre compte, non recalculable sans la clé du serveur', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const a = blindOrder(KEY, 'compte-a', ids);
  expect(a).toHaveLength(ids.length);
  expect([...a].sort()).toEqual([...ids].sort());
  // Stable : même compte, même ordre, quel que soit l'ordre d'entrée.
  expect(blindOrder(KEY, 'compte-a', [...ids].reverse())).toEqual(a);
  // Ni l'ordre de création ni l'ordre d'un autre compte.
  expect(a).not.toEqual(ids);
  expect(blindOrder(KEY, 'compte-b', ids)).not.toEqual(a);
  // Ni les formules sans clé, ni la même formule avec une autre clé.
  expect(a).not.toEqual(unkeyedOrder('compte-a', ids));
  expect(a).not.toEqual(unkeyedOrder('compte-a', ids, ':'));
  expect(blindOrder(blindOrderKey(Buffer.alloc(32, 8)), 'compte-a', ids)).not.toEqual(a);
});

/**
 * Série : un test manuel (avec une pièce jointe dans l'instantané) et un test à réponse attendue, deux modèles,
 * deux répétitions ; les quatre résultats du test manuel sont terminés avec texte et métriques.
 */
async function setup(opts: { repetitions?: number } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aic-manual-'));
  dirs.push(dataDir);
  const t = await buildTestApp({ fakeLlm: true, dataDir });
  created.push(t);
  const adminRow = await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin', name: 'Alice Admin' });
  const userRow = await seedUser(t.db, { email: 'user@acme.fr', role: 'user', name: 'Ulysse Util' });
  await seedUser(t.db, { email: 'autre@acme.fr', role: 'user', name: 'Oscar Autre' });
  const admin = await loginAs(t.app, 'admin@acme.fr', PW);
  const user = await loginAs(t.app, 'user@acme.fr', PW);
  const other = await loginAs(t.app, 'autre@acme.fr', PW);
  type Session = typeof admin;
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, s: Session, payload?: unknown) =>
    t.app.inject({
      method,
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const get = (url: string, s: Session = admin) => call('GET', url, s);
  const put = (url: string, payload: unknown, s: Session = admin) => call('PUT', url, s, payload);

  const provider = await seedProvider(t.db, {});
  const m1 = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-equilibre', displayName: 'Faux équilibré', color: '#aa0001' });
  const m2 = await seedModel(t.db, { providerId: provider.id, apiModelId: 'fake-rapide', displayName: 'Faux rapide', color: '#aa0002' });
  const manualTest = await call('POST', '/api/tests', admin, {
    name: 'Rédaction',
    category: 'Écriture',
    systemPrompt: 'Tu es concis.',
    userPrompt: 'Écris un haïku',
    scoringMethod: 'manual',
    scoringConfig: {},
  });
  const expectedTest = await call('POST', '/api/tests', admin, {
    name: 'Capitale',
    category: 'Culture',
    userPrompt: 'Capitale de la France ?',
    scoringMethod: 'expected',
    scoringConfig: { mode: 'exact', expected: 'Paris' },
  });
  const run = await call('POST', '/api/runs', admin, {
    name: 'Série aveugle',
    testIds: [manualTest.json().test.id, expectedTest.json().test.id],
    modelIds: [m1.id, m2.id],
    repetitions: opts.repetitions ?? 2,
  });
  expect(run.statusCode).toBe(201);
  const runId = run.json().run.id as string;
  const rts = await t.db.select().from(runTests).where(eq(runTests.runId, runId)).orderBy(asc(runTests.position));
  const rt = rts[0]!.id;
  const expectedRt = rts[1]!.id;

  // Pièce jointe figée dans l'instantané du test manuel.
  const storagePath = 'attachments/figee/piece';
  await mkdir(path.join(dataDir, 'attachments', 'figee'), { recursive: true });
  await writeFile(path.join(dataDir, storagePath), Buffer.from('%PDF-1.4 contenu'));
  await t.db
    .update(runTests)
    .set({
      snapshot: {
        ...rts[0]!.snapshot,
        attachments: [
          { id: '11111111-2222-4333-8444-555555555555', originalName: 'énoncé.pdf', mime: 'application/pdf', size: 16, sha256: 'x', pages: 1, storagePath },
        ],
      },
    })
    .where(eq(runTests.id, rt));

  const manualResults = await t.db.select().from(results).where(eq(results.runTestId, rt)).orderBy(asc(results.id));
  for (const [i, r] of manualResults.entries()) {
    await t.db
      .update(results)
      .set({
        status: 'done',
        attempts: 1,
        responseText: `Texte numéro ${i}`,
        finishReason: 'stop',
        ttftMs: 100 + i,
        inputTokens: 10,
        outputTokens: 50 + i,
        tokensPerS: 40 + i,
        costUsd: 0.001 * (i + 1),
        totalMs: 900 + i,
        completedAt: new Date('2026-01-15T10:00:00.000Z'),
      })
      .where(eq(results.id, r.id));
  }
  await t.db.update(results).set({ status: 'done', responseText: 'Paris' }).where(eq(results.runTestId, expectedRt));
  const modelNameOf = new Map([
    [m1.id, 'Faux équilibré'],
    [m2.id, 'Faux rapide'],
  ]);
  const colorOf = new Map([
    [m1.id, '#aa0001'],
    [m2.id, '#aa0002'],
  ]);
  return { ...t, dataDir, adminRow, userRow, admin, user, other, get, put, runId, rt, expectedRt, manualResults, modelNameOf, colorOf };
}

type Setup = Awaited<ReturnType<typeof setup>>;
type Answer = { letter: string; responseText: string; myScore: number | null; myComment: string | null };

/** Note toutes les réponses de la question pour ce compte : `scoreOf(texte)` donne la note de chaque réponse. */
async function scoreAll(s: Setup, session: Setup['admin'], scoreOf: (text: string) => number, comment?: string) {
  const q = (await s.get(`/api/scoring/questions/${s.rt}`, session)).json();
  const scores = (q.answers as Answer[]).map((a) => ({ letter: a.letter, score: scoreOf(a.responseText), ...(comment ? { comment } : {}) }));
  return s.put(`/api/scoring/questions/${s.rt}/manual`, { scores }, session);
}

test('question anonymisée : ni identifiant de résultat ni nom de modèle tant qu’elle n’est pas complète', async () => {
  const s = await setup();
  const res = await s.get(`/api/scoring/questions/${s.rt}`, s.user);
  expect(res.statusCode).toBe(200);
  const { runTestId, ...rest } = res.json();
  expect(runTestId).toBe(s.rt);
  const body = JSON.stringify(rest);
  expect(body).not.toMatch(UUID);
  expect(body).not.toContain('Faux équilibré');
  expect(body).not.toContain('Faux rapide');
  expect(body).not.toContain('#aa000');
  expect(rest).toEqual({
    runName: 'Série aveugle',
    testName: 'Rédaction',
    systemPrompt: 'Tu es concis.',
    userPrompt: 'Écris un haïku',
    attachments: [{ index: 0, originalName: 'énoncé.pdf', mime: 'application/pdf' }],
    answers: expect.any(Array),
    complete: false,
  });
  // Aucune métrique ni répétition : seules la lettre, la réponse et la note du compte.
  const answers = rest.answers as Answer[];
  expect(answers.map((a) => a.letter)).toEqual(['A', 'B', 'C', 'D']);
  for (const a of answers) expect(Object.keys(a).sort()).toEqual(['letter', 'myComment', 'myScore', 'responseText']);
  // L'ordre suit le hachage du compte, pas l'ordre de création.
  const byText = new Map(s.manualResults.map((r, i) => [`Texte numéro ${i}`, r.id]));
  expect(answers.map((a) => byText.get(a.responseText))).toEqual(blindOrder(KEY, s.userRow.id, s.manualResults.map((r) => r.id)));

  // Pièce jointe de l'instantané : mêmes en-têtes que le téléchargement du plan 3.
  const file = await s.get(`/api/scoring/questions/${s.rt}/attachments/0`, s.user);
  expect(file.statusCode).toBe(200);
  expect(file.body).toBe('%PDF-1.4 contenu');
  expect(file.headers['content-type']).toBe('application/pdf');
  expect(file.headers['content-disposition']).toMatch(/^attachment; /);
  expect(file.headers['x-content-type-options']).toBe('nosniff');
  expect(file.headers['cache-control']).toContain('no-store');
  expect((await s.get(`/api/scoring/questions/${s.rt}/attachments/1`, s.user)).statusCode).toBe(404);

  // Test non manuel ou inconnu : introuvable.
  expect((await s.get(`/api/scoring/questions/${s.expectedRt}`, s.user)).statusCode).toBe(404);
  expect((await s.get('/api/scoring/questions/00000000-0000-4000-8000-000000000000', s.user)).statusCode).toBe(404);
});

test('enregistrer toutes les notes révèle les modèles ; moyenne des évaluateurs ; scoreStatus done', async () => {
  const s = await setup();
  const textOf = new Map(s.manualResults.map((r, i) => [r.id, `Texte numéro ${i}`]));
  const scoreOfText = (text: string) => Number(text.slice(-1)) * 2; // 0, 2, 4, 6
  const res = await scoreAll(s, s.user, scoreOfText, '  Bien  ');
  expect(res.statusCode).toBe(200);
  const q = res.json();
  expect(q.complete).toBe(true);
  expect((q.answers as Answer[]).every((a) => a.myScore === scoreOfText(a.responseText) && a.myComment === 'Bien')).toBe(true);
  // Révélation : chaque lettre associée au modèle de sa réponse.
  const resultOfText = new Map(s.manualResults.map((r, i) => [`Texte numéro ${i}`, r]));
  expect(q.reveal).toEqual(
    (q.answers as Answer[]).map((a) => {
      const r = resultOfText.get(a.responseText)!;
      return { letter: a.letter, modelName: s.modelNameOf.get(r.modelId), color: s.colorOf.get(r.modelId) };
    }),
  );
  expect(JSON.stringify(q)).not.toMatch(new RegExp(s.manualResults.map((r) => r.id).join('|')));

  // Relecture : même révélation.
  expect((await s.get(`/api/scoring/questions/${s.rt}`, s.user)).json().reveal).toEqual(q.reveal);

  // Résultats : note enregistrée et scoreStatus `done`.
  const rows = await s.db.select().from(results).where(eq(results.runTestId, s.rt));
  expect(rows.every((r) => r.scoreStatus === 'done')).toBe(true);
  const scores = await s.db.select().from(manualScores);
  expect(scores).toHaveLength(4);
  expect(scores.every((m) => m.userId === s.userRow.id && m.score === scoreOfText(textOf.get(m.resultId)!))).toBe(true);

  // Second évaluateur (Admin) : 10 partout ; nouvel enregistrement de l'Utilisateur par upsert (aucune ligne en plus).
  expect((await scoreAll(s, s.admin, () => 10)).statusCode).toBe(200);
  expect((await scoreAll(s, s.user, scoreOfText)).statusCode).toBe(200);
  const all = await s.db.select().from(manualScores);
  expect(all).toHaveLength(8);
  expect(all.filter((m) => m.userId === s.userRow.id).every((m) => m.comment === null)).toBe(true);

  // Moyenne des évaluateurs : (note Utilisateur + 10) ÷ 2.
  const spread = (await s.get(`/api/scoring/runs/${s.runId}/spread`)).json().items as { resultId: string; mean: number; raters: number }[];
  for (const item of spread) {
    expect(item.raters).toBe(2);
    expect(item.mean).toBe((scoreOfText(textOf.get(item.resultId)!) + 10) / 2);
  }
});

test('note 11 ou 7,5 refusée ; lettre inconnue → 400 ; question partielle → 400', async () => {
  const s = await setup();
  const url = `/api/scoring/questions/${s.rt}/manual`;
  const full = (over: Partial<{ letter: string; score: unknown }> = {}) =>
    ['A', 'B', 'C', 'D'].map((letter, i) => (i === 0 ? { letter, score: 5, ...over } : { letter, score: 5 }));
  for (const score of [11, 7.5, -1, '5']) {
    const res = await s.put(url, { scores: full({ score }) }, s.user);
    expect(res.statusCode, String(score)).toBe(400);
    expect(res.json().error.code).toBe('validation');
  }
  let res = await s.put(url, { scores: [...full().slice(1), { letter: 'E', score: 5 }] }, s.user);
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe('validation');

  res = await s.put(url, { scores: full().slice(0, 3) }, s.user);
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toEqual({ code: 'validation', message: 'Notez toutes les réponses de la question' });

  res = await s.put(url, { scores: [...full(), { letter: 'A', score: 3 }] }, s.user);
  expect(res.statusCode).toBe(400);

  res = await s.put(url, { scores: full().map((x) => ({ ...x, comment: 'x'.repeat(2001) })) }, s.user);
  expect(res.statusCode).toBe(400);

  expect(await s.db.select().from(manualScores)).toHaveLength(0);
  const rows = await s.db.select().from(results).where(eq(results.runTestId, s.rt));
  expect(rows.every((r) => r.scoreStatus === 'awaiting_manual')).toBe(true);

  // Bornes acceptées.
  res = await s.put(url, { scores: ['A', 'B', 'C', 'D'].map((letter, i) => ({ letter, score: i % 2 === 0 ? 0 : 10 })) }, s.user);
  expect(res.statusCode).toBe(200);
});

test('À noter : compte et liste par compte, question complète retirée', async () => {
  const s = await setup();
  const todo = (session: Setup['admin']) => s.get('/api/scoring/todo', session).then((r) => r.json());
  const expected = { runTestId: s.rt, runId: s.runId, runName: 'Série aveugle', testName: 'Rédaction', answers: 4, scoredByMe: 0 };
  expect(await todo(s.user)).toEqual({ items: [expected], count: 1 });
  expect(await todo(s.admin)).toEqual({ items: [expected], count: 1 });

  // Une réponse notée par l'Utilisateur (directement en base) : avancement par compte.
  await s.db.insert(manualScores).values({ id: '99999999-0000-4000-8000-000000000000', resultId: s.manualResults[0]!.id, userId: s.userRow.id, score: 4 });
  expect(await todo(s.user)).toEqual({ items: [{ ...expected, scoredByMe: 1 }], count: 1 });

  expect((await scoreAll(s, s.user, () => 7)).statusCode).toBe(200);
  expect(await todo(s.user)).toEqual({ items: [], count: 0 });
  expect(await todo(s.admin)).toEqual({ items: [expected], count: 1 });
  expect(await todo(s.other)).toEqual({ items: [expected], count: 1 });

  // Sans réponse terminée, la question n'est pas à noter.
  await s.db.update(results).set({ status: 'error' }).where(eq(results.runTestId, s.rt));
  expect(await todo(s.admin)).toEqual({ items: [], count: 0 });
});

test('résultats d’une série : réponses d’un test manuel masquées à l’Utilisateur qui n’a pas noté, visibles après', async () => {
  const s = await setup();
  type Row = { id: string; runTestId: string; responseText: string | null; hiddenUntilScored: boolean; ttftMs: number | null };
  const rowsFor = async (session: Setup['admin']) => (await s.get(`/api/runs/${s.runId}/results`, session)).json().results as Row[];

  let rows = await rowsFor(s.user);
  expect(rows).toHaveLength(8);
  for (const r of rows.filter((x) => x.runTestId === s.rt)) {
    // Ni texte ni métrique (la longueur ou la durée rapprocheraient une lettre de son modèle) ; identité et statut gardés.
    expect(r).toMatchObject({
      modelName: expect.stringMatching(/^Faux /),
      status: 'done',
      repetition: expect.any(Number),
      scoreStatus: 'awaiting_manual',
      responseText: null,
      finishReason: null,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      ttftMs: null,
      totalMs: null,
      tokensPerS: null,
      costUsd: null,
      attempts: null,
      completedAt: null,
      hiddenUntilScored: true,
    });
  }
  for (const r of rows.filter((x) => x.runTestId === s.expectedRt)) expect(r).toMatchObject({ responseText: 'Paris', hiddenUntilScored: false });

  // L'Admin voit tout, même sans avoir noté.
  for (const r of await rowsFor(s.admin)) {
    expect(r.hiddenUntilScored).toBe(false);
    expect(r.responseText).not.toBeNull();
  }

  expect((await scoreAll(s, s.user, () => 6)).statusCode).toBe(200);
  rows = await rowsFor(s.user);
  for (const r of rows.filter((x) => x.runTestId === s.rt)) expect(r.ttftMs).not.toBeNull();
  for (const r of rows) {
    expect(r.hiddenUntilScored).toBe(false);
    expect(r.responseText).not.toBeNull();
  }
  // Un autre Utilisateur qui n'a pas noté reste masqué.
  expect((await rowsFor(s.other)).filter((r) => r.runTestId === s.rt).every((r) => r.hiddenUntilScored && r.responseText === null)).toBe(true);
});

test('écarts entre évaluateurs : réservé à l’Admin (403), écart-type exact', async () => {
  const s = await setup();
  const url = `/api/scoring/runs/${s.runId}/spread`;
  expect((await s.get(url, s.user)).statusCode).toBe(403);

  // Avant toute note : quatre réponses du test manuel, aucune note.
  let items = (await s.get(url)).json().items as Record<string, unknown>[];
  expect(items).toHaveLength(4);
  expect(items.every((i) => i.raters === 0 && i.mean === null && i.stdDev === null)).toBe(true);

  // Scores 4 et 8 → moyenne 6, écart-type 2 ; 3, 4 et 8 → moyenne 5, écart-type √(14/3) ≈ 2,16.
  expect((await scoreAll(s, s.user, () => 4, 'Moyen')).statusCode).toBe(200);
  expect((await scoreAll(s, s.admin, () => 8)).statusCode).toBe(200);
  items = (await s.get(url)).json().items;
  const target = s.manualResults[0]!;
  const item = items.find((i) => i.resultId === target.id)!;
  expect(item).toEqual({
    resultId: target.id,
    runTestId: s.rt,
    testName: 'Rédaction',
    modelName: s.modelNameOf.get(target.modelId),
    raters: 2,
    mean: 6,
    stdDev: 2,
    scores: expect.arrayContaining([
      { userName: 'Ulysse Util', score: 4, comment: 'Moyen' },
      { userName: 'Alice Admin', score: 8, comment: null },
    ]),
  });
  expect((await scoreAll(s, s.other, () => 3)).statusCode).toBe(200);
  items = (await s.get(url)).json().items;
  expect(items.find((i) => i.resultId === target.id)).toMatchObject({ raters: 3, mean: 5, stdDev: 2.16 });

  expect((await s.get('/api/scoring/runs/00000000-0000-4000-8000-000000000000/spread')).statusCode).toBe(404);
});

test('ordre servi non recalculable à partir des identifiants visibles dans les résultats', async () => {
  const s = await setup({ repetitions: 5 }); // dix réponses : une coïncidence d'ordre est exclue en pratique
  const me = (await s.get('/api/auth/me', s.user)).json();
  const myId = me.user.id as string;
  expect(myId).toBe(s.userRow.id);
  const visibleIds = ((await s.get(`/api/runs/${s.runId}/results`, s.user)).json().results as { id: string; runTestId: string }[])
    .filter((r) => r.runTestId === s.rt)
    .map((r) => r.id);
  expect(visibleIds).toHaveLength(10);
  // Ordre réellement servi, traduit en identifiants grâce aux textes connus du banc d'essai.
  const byText = new Map(s.manualResults.map((r, i) => [`Texte numéro ${i}`, r.id]));
  const answers = (await s.get(`/api/scoring/questions/${s.rt}`, s.user)).json().answers as Answer[];
  const served = answers.map((a) => byText.get(a.responseText));
  expect(served).toEqual(blindOrder(KEY, myId, visibleIds));
  expect(served).not.toEqual(unkeyedOrder(myId, visibleIds));
  expect(served).not.toEqual(unkeyedOrder(myId, visibleIds, ':'));
  // Un autre compte reçoit un autre ordre.
  const otherAnswers = (await s.get(`/api/scoring/questions/${s.rt}`, s.other)).json().answers as Answer[];
  expect(otherAnswers.map((a) => byText.get(a.responseText))).not.toEqual(served);
});

test('fil d’activité : durée et coût masqués à l’Utilisateur sur une question manuelle non notée, visibles après', async () => {
  const s = await setup();
  type Item = { resultId: string; testName: string; modelName: string; status: string; totalMs: number | null; costUsd: number | null; hiddenUntilScored: boolean };
  const activity = async (session: Setup['admin']) => (await s.get(`/api/runs/${s.runId}/progress`, session)).json().progress.activity as Item[];
  const manualIds = new Set(s.manualResults.map((r) => r.id));
  const isManual = (i: Item) => manualIds.has(i.resultId);

  let items = await activity(s.user);
  expect(items.filter(isManual)).toHaveLength(4);
  for (const i of items.filter(isManual)) {
    // Le fil continue d'avancer : modèle, test et statut restent visibles.
    expect(i).toMatchObject({ testName: 'Rédaction', modelName: expect.stringMatching(/^Faux /), status: 'done', totalMs: null, costUsd: null, hiddenUntilScored: true });
  }
  // L'Admin voit les mesures.
  for (const i of (await activity(s.admin)).filter(isManual)) {
    expect(i.hiddenUntilScored).toBe(false);
    expect(i.totalMs).not.toBeNull();
    expect(i.costUsd).not.toBeNull();
  }
  expect((await scoreAll(s, s.user, () => 5)).statusCode).toBe(200);
  items = await activity(s.user);
  for (const i of items.filter(isManual)) {
    expect(i.hiddenUntilScored).toBe(false);
    expect(i.totalMs).not.toBeNull();
    expect(i.costUsd).not.toBeNull();
  }
  // Un autre Utilisateur qui n'a pas noté reste masqué.
  expect((await activity(s.other)).filter(isManual).every((i) => i.hiddenUntilScored && i.totalMs === null && i.costUsd === null)).toBe(true);
});
