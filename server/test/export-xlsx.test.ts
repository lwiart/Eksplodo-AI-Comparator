import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { afterEach, expect, test } from 'vitest';
import { manualScores, results, runTests } from '../src/db/schema/runs.js';
import { csvDocument, type CsvValue } from '../src/modules/scoring/csv.js';
import { DEFINITION_LABELS, DEFINITIONS } from '../src/modules/scoring/definitions.js';
import { buildTestApp, loginAs, seedModel, seedProvider, seedUser, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const created: TestApp[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

/**
 * Série « Polyvalence d’octobre » (comme results-api.test.ts) : un test à réponse attendue (Culture) et un test manuel
 * (Écriture), modèles A et B, une répétition. A répond juste, B faux avec une formule ; notes manuelles de l'Admin : A 80,
 * B 60. Le juge a coûté 0,5 $ sur le résultat de A.
 */
async function setup() {
  const t = await buildTestApp({ fakeLlm: true });
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
    .set({ ...done, responseText: 'Paris', ttftMs: 100, totalMs: 900, tokensPerS: 50, outputTokens: 20, reasoningTokens: 4, costUsd: 0.002, scoreStatus: 'done', autoScore: 100, judgeCostUsd: 0.5 })
    .where(eq(results.id, ids.expA));
  await t.db
    .update(results)
    .set({ ...done, responseText: '=SOMME(A1:A2)', ttftMs: 200, totalMs: 1200, tokensPerS: 100, outputTokens: 30, costUsd: 0.004, scoreStatus: 'done', autoScore: 0 })
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
  await rate(ids.manA, adminRow.id, 80);
  await rate(ids.manB, adminRow.id, 60);

  return { admin, user, get, runId, ids, userRow, rate };
}

async function readWorkbook(payload: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(payload as unknown as ArrayBuffer);
  return wb;
}

/** Valeurs d'une ligne (colonnes 1 à `width`), cellule vide → null. */
function rowValues(ws: ExcelJS.Worksheet, rowNumber: number, width: number): CsvValue[] {
  return Array.from({ length: width }, (_, i) => {
    const v = ws.getRow(rowNumber).getCell(i + 1).value;
    return v === null || v === undefined ? null : (v as string | number);
  });
}

/** Lignes de données d'un tableau (sous l'en-tête), jusqu'à la première ligne vide. */
function tableRows(ws: ExcelJS.Worksheet, width: number): CsvValue[][] {
  const out: CsvValue[][] = [];
  for (let n = 2; n <= ws.rowCount; n++) {
    const values = rowValues(ws, n, width);
    if (values.every((v) => v === null)) break;
    out.push(values);
  }
  return out;
}

type RankingJson = {
  weights: { quality: number; speed: number; cost: number; reliability: number };
  models: {
    name: string;
    providerName: string;
    quality: number | null;
    speed: number | null;
    cost: number | null;
    reliability: number | null;
    raw: { medianTtftMs: number | null; medianTokensPerS: number | null; meanCostUsd: number | null };
  }[];
};

/** Lignes attendues de la feuille Classement à partir de `GET /api/runs/:id/ranking` (pondération de la série, notes arrondies). */
function expectedRanking(body: RankingJson): CsvValue[][] {
  const round = (n: number | null) => (n === null ? null : Math.round(n));
  const w = body.weights;
  const scored = body.models.map((m) => {
    if (m.quality === null) return { m, global: null };
    const parts = [[m.quality, w.quality], [m.speed, w.speed], [m.cost, w.cost], [m.reliability, w.reliability]] as const;
    let sum = 0;
    let weight = 0;
    for (const [note, wt] of parts) {
      if (note === null) continue;
      sum += note * wt;
      weight += wt;
    }
    return { m, global: weight === 0 ? null : sum / weight };
  });
  return scored.map(({ m, global }, i) => [
    global === null ? null : i + 1,
    m.name,
    m.providerName,
    round(global),
    round(m.quality),
    round(m.speed),
    round(m.cost),
    round(m.reliability),
    round(m.raw.medianTtftMs),
    m.raw.medianTokensPerS === null ? null : Math.round(m.raw.medianTokensPerS * 10) / 10,
    m.raw.meanCostUsd,
  ]);
}

const RANKING_HEADER = [
  'Rang',
  'Modèle',
  'Fournisseur',
  'Score global',
  'Qualité',
  'Vitesse',
  'Coût',
  'Fiabilité',
  'Premier token médian (ms)',
  'Débit médian (tokens/s)',
  'Coût moyen par réponse ($)',
];

test('export XLSX : en-têtes HTTP, trois feuilles mises en forme, classement de la page, résultats du CSV, définitions', async () => {
  const { admin, get, runId } = await setup();
  const res = await get(`/api/runs/${runId}/export.xlsx`, admin);
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe(XLSX_MIME);
  expect(res.headers['content-disposition']).toBe(
    'attachment; filename="serie-polyvalence-d-octobre.xlsx"; filename*=UTF-8\'\'serie-polyvalence-d-octobre.xlsx',
  );
  expect(res.headers['cache-control']).toBe('private, no-store');

  const wb = await readWorkbook(res.rawPayload);
  expect(wb.worksheets.map((ws) => ws.name)).toEqual(['Classement', 'Résultats', 'Définitions']);

  // Chaque feuille : en-tête en gras blanc sur fond orange Eksplodo, volet figé sous l'en-tête, colonnes élargies.
  for (const ws of wb.worksheets) {
    const header = ws.getRow(1);
    header.eachCell((cell) => {
      expect(cell.font).toMatchObject({ bold: true, color: { argb: 'FFFFFFFF' } });
      expect(cell.fill).toMatchObject({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0631F' } });
    });
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    ws.columns.forEach((col) => expect(col.width).toBeGreaterThanOrEqual(8));
  }

  // Classement : mêmes valeurs que GET /ranking, dans l'ordre du classement, notes entières, coûts avec leurs décimales.
  const classement = wb.getWorksheet('Classement')!;
  expect(rowValues(classement, 1, 11)).toEqual(RANKING_HEADER);
  const ranking = (await get(`/api/runs/${runId}/ranking`, admin)).json() as RankingJson;
  const rows = tableRows(classement, 11);
  expect(rows).toEqual(expectedRanking(ranking));
  // A : global (90×50 + 60×20 + 100×20 + 100×10) / 100 = 87 ; B : (30×50 + 60×20 + 20×20 + 100×10) / 100 = 41.
  expect(rows).toEqual([
    [1, 'Modèle A', 'Fournisseur Alpha', 87, 90, 60, 100, 100, 100, 50, 0.0015],
    [2, 'Modèle B', 'Fournisseur Alpha', 41, 30, 60, 20, 100, 200, 100, 0.003],
  ]);
  expect(classement.getColumn(4).numFmt).toBe('0');
  expect(classement.getColumn(11).numFmt).toBe('0.000000 "$"');
  // Notes de bas de tableau, après une ligne vide : pondération et renvoi vers la feuille Définitions.
  expect(classement.getRow(5).getCell(1).value).toBe(
    "Pondération de la série : qualité 50 %, vitesse 20 %, coût 20 %, fiabilité 10 %. Notes sur 100 arrondies à l'entier.",
  );
  expect(classement.getRow(6).getCell(1).value).toBe('Définitions des critères : voir la feuille « Définitions ».');

  // Résultats : exactement le contenu du CSV (réécrit en CSV, il lui est identique), nombres typés, jamais de formule.
  const resultats = wb.getWorksheet('Résultats')!;
  const csv = (await get(`/api/runs/${runId}/export.csv`, admin)).body;
  const header = rowValues(resultats, 1, 20);
  const lines = tableRows(resultats, 20);
  expect(csvDocument([header, ...lines])).toBe(csv);
  expect(lines[0]).toEqual(['Polyvalence d’octobre', 'Capitale', 'Culture', 'Modèle A', 1, 'réussi', 100, 100, null, null, 100, 900, 50, 10, 20, 4, 0.002, 0.5, null, 'Paris']);
  const formulaText = resultats.getRow(3).getCell(20);
  expect(formulaText.value).toBe('=SOMME(A1:A2)');
  expect(formulaText.type).toBe(ExcelJS.ValueType.String);
  for (const ws of wb.worksheets) ws.eachRow((row) => row.eachCell((cell) => expect(cell.formula).toBeUndefined()));
  expect(resultats.getColumn(17).numFmt).toBe('0.000000 "$"');

  // Définitions : une ligne par critère, textes partagés avec le client.
  const definitions = wb.getWorksheet('Définitions')!;
  expect(rowValues(definitions, 1, 2)).toEqual(['Critère', 'Définition']);
  expect(tableRows(definitions, 2)).toEqual(
    (['global', 'quality', 'speed', 'cost', 'reliability'] as const).map((k) => [DEFINITION_LABELS[k], DEFINITIONS[k]]),
  );
});

test('export XLSX d’un Utilisateur : mêmes masquages que le CSV et le classement ; 401 sans session, 404 série inconnue', async () => {
  const { user, get, runId, ids, userRow, rate } = await setup();
  expect((await get(`/api/runs/${runId}/export.xlsx`, null)).statusCode).toBe(401);
  expect((await get(`/api/runs/${randomUUID()}/export.xlsx`, user)).statusCode).toBe(404);

  const check = async () => {
    const res = await get(`/api/runs/${runId}/export.xlsx`, user);
    expect(res.statusCode).toBe(200);
    const wb = await readWorkbook(res.rawPayload);
    const ranking = (await get(`/api/runs/${runId}/ranking`, user)).json() as RankingJson;
    const rankingRows = tableRows(wb.getWorksheet('Classement')!, 11);
    expect(rankingRows).toEqual(expectedRanking(ranking));
    const resultats = wb.getWorksheet('Résultats')!;
    const csv = (await get(`/api/runs/${runId}/export.csv`, user)).body;
    expect(csvDocument([rowValues(resultats, 1, 20), ...tableRows(resultats, 20)])).toBe(csv);
    return { rankingRows, lines: tableRows(resultats, 20) };
  };

  // Question manuelle non notée : qualité sur le seul test à réponse attendue, réponses manuelles masquées.
  const before = await check();
  expect(before.rankingRows.map((r) => r[4])).toEqual([100, 0]);
  expect(before.lines[2]).toEqual([
    'Polyvalence d’octobre', 'Rédaction', 'Écriture', 'Modèle A', 1, 'réussi',
    ...Array<null>(13).fill(null),
    "(masquée jusqu'à notation)",
  ]);

  // Après sa notation : notes (moyenne des deux évaluateurs) et réponses visibles.
  await rate(ids.manA, userRow.id, 40);
  await rate(ids.manB, userRow.id, 70);
  const after = await check();
  expect(after.lines[2]).toEqual(expect.arrayContaining([60, 'Haïku de A\nsur deux lignes']));
});
