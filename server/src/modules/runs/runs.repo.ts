import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { models } from '../../db/schema/catalog.js';
import { results, runModels, runTests, runs } from '../../db/schema/runs.js';
import { suites } from '../../db/schema/tests.js';
import type { DbOrTx } from '../jobs/queue.js';

export type RunRow = typeof runs.$inferSelect;
export type ResultStatus = (typeof results.$inferSelect)['status'];

/** Nom et catégorie lus dans l'instantané, sans charger les prompts. */
const snapshotName = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${runTests.snapshot}, '$.name'))`;
const snapshotCategory = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${runTests.snapshot}, '$.category'))`;

const INSERT_CHUNK = 1000;
/** Instantanés : au plus 50 lignes et ~4 Mo de JSON par INSERT, bien sous `max_allowed_packet`. */
const SNAPSHOT_CHUNK_ROWS = 50;
const SNAPSHOT_CHUNK_BYTES = 4 * 1024 * 1024;

/** Insère par paquets (une série peut compter des dizaines de milliers de résultats). */
async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) await insert(rows.slice(i, i + INSERT_CHUNK));
}

/** Découpe en paquets d'au plus `maxRows` lignes et `maxBytes` octets (une ligne plus grosse forme un paquet seule). */
export function chunkBySize<T>(rows: T[], sizeOf: (row: T) => number, maxRows: number, maxBytes: number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = sizeOf(row);
    if (current.length > 0 && (current.length >= maxRows || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function createRunsRepo(db: Db) {
  return {
    async insertRun(tx: DbOrTx, values: typeof runs.$inferInsert): Promise<void> {
      await tx.insert(runs).values(values);
    },
    async insertRunModels(tx: DbOrTx, rows: (typeof runModels.$inferInsert)[]): Promise<void> {
      await insertChunked(rows, (chunk) => tx.insert(runModels).values(chunk));
    },
    async insertRunTests(tx: DbOrTx, rows: (typeof runTests.$inferInsert)[]): Promise<void> {
      const sizeOf = (r: typeof runTests.$inferInsert) => Buffer.byteLength(JSON.stringify(r.snapshot));
      for (const chunk of chunkBySize(rows, sizeOf, SNAPSHOT_CHUNK_ROWS, SNAPSHOT_CHUNK_BYTES)) {
        await tx.insert(runTests).values(chunk);
      }
    },
    async insertResults(tx: DbOrTx, rows: (typeof results.$inferInsert)[]): Promise<void> {
      await insertChunked(rows, (chunk) => tx.insert(results).values(chunk));
    },

    /** Séries avec le nom de leur suite et de leur juge, les plus récentes d'abord. */
    async listRuns(id?: string) {
      return db
        .select({ run: runs, suiteName: suites.name, judgeModelName: models.displayName })
        .from(runs)
        .leftJoin(suites, eq(suites.id, runs.suiteId))
        .leftJoin(models, eq(models.id, runs.judgeModelId))
        .where(id === undefined ? undefined : eq(runs.id, id))
        .orderBy(desc(runs.createdAt), desc(runs.id));
    },

    /** Nombre de modèles et de tests de chaque série. */
    async sizes(runIds: string[]): Promise<Map<string, { modelCount: number; testCount: number }>> {
      const out = new Map<string, { modelCount: number; testCount: number }>();
      if (runIds.length === 0) return out;
      const [m, t] = await Promise.all([
        db
          .select({ runId: runModels.runId, n: sql<number>`COUNT(*)` })
          .from(runModels)
          .where(inArray(runModels.runId, runIds))
          .groupBy(runModels.runId),
        db
          .select({ runId: runTests.runId, n: sql<number>`COUNT(*)` })
          .from(runTests)
          .where(inArray(runTests.runId, runIds))
          .groupBy(runTests.runId),
      ]);
      for (const id of runIds) out.set(id, { modelCount: 0, testCount: 0 });
      for (const r of m) out.get(r.runId)!.modelCount = Number(r.n);
      for (const r of t) out.get(r.runId)!.testCount = Number(r.n);
      return out;
    },

    /** Nombre de résultats par série et par statut. */
    async statusCounts(runIds: string[]) {
      if (runIds.length === 0) return [];
      const rows = await db
        .select({ runId: results.runId, status: results.status, n: sql<number>`COUNT(*)` })
        .from(results)
        .where(inArray(results.runId, runIds))
        .groupBy(results.runId, results.status);
      return rows.map((r) => ({ ...r, n: Number(r.n) }));
    },

    /** Modèles de la série, dans leur ordre d'ajout. */
    async runModelsOf(runId: string) {
      return db
        .select({ id: models.id, name: models.displayName, color: models.color })
        .from(runModels)
        .innerJoin(models, eq(models.id, runModels.modelId))
        .where(eq(runModels.runId, runId))
        .orderBy(asc(runModels.addedAt), asc(models.displayName), asc(models.id));
    },

    /** Tests de la série dans l'ordre des positions (nom tiré de l'instantané). */
    async runTestsOf(runId: string) {
      return db
        .select({ id: runTests.id, name: snapshotName, category: snapshotCategory })
        .from(runTests)
        .where(eq(runTests.runId, runId))
        .orderBy(asc(runTests.position));
    },

    /** Nombre de résultats par test, modèle et statut. */
    async cellCounts(runId: string) {
      const rows = await db
        .select({ runTestId: results.runTestId, modelId: results.modelId, status: results.status, n: sql<number>`COUNT(*)` })
        .from(results)
        .where(eq(results.runId, runId))
        .groupBy(results.runTestId, results.modelId, results.status);
      return rows.map((r) => ({ ...r, n: Number(r.n) }));
    },

    async runningOf(runId: string) {
      return db
        .select({ modelId: results.modelId, testName: snapshotName })
        .from(results)
        .innerJoin(runTests, eq(runTests.id, results.runTestId))
        .where(and(eq(results.runId, runId), eq(results.status, 'running')))
        .orderBy(asc(results.startedAt), asc(runTests.position), asc(results.id));
    },

    /** Derniers résultats terminés (réponse, erreur ou délai dépassé), du plus récent au plus ancien. */
    async recentActivity(runId: string, limit: number) {
      return db
        .select({
          resultId: results.id,
          runTestId: results.runTestId,
          testName: snapshotName,
          modelId: results.modelId,
          modelName: models.displayName,
          color: models.color,
          status: results.status,
          totalMs: results.totalMs,
          costUsd: results.costUsd,
          completedAt: results.completedAt,
        })
        .from(results)
        .innerJoin(runTests, eq(runTests.id, results.runTestId))
        .innerJoin(models, eq(models.id, results.modelId))
        .where(and(eq(results.runId, runId), inArray(results.status, ['done', 'error', 'timeout']), isNotNull(results.completedAt)))
        .orderBy(desc(results.completedAt), desc(results.id))
        .limit(limit);
    },

    /** Moyenne observée de `total_ms` des résultats `done` de la série ; `null` sans mesure. */
    async averageTotalMs(runId: string): Promise<number | null> {
      const [row] = await db
        .select({ avg: sql<string | null>`AVG(${results.totalMs})` })
        .from(results)
        .where(and(eq(results.runId, runId), eq(results.status, 'done'), isNotNull(results.totalMs)));
      return row?.avg == null ? null : Number(row.avg);
    },

    async resultsOf(runId: string) {
      return db
        .select({
          result: results,
          testName: snapshotName,
          category: snapshotCategory,
          modelName: models.displayName,
          color: models.color,
        })
        .from(results)
        .innerJoin(runTests, eq(runTests.id, results.runTestId))
        .innerJoin(models, eq(models.id, results.modelId))
        .innerJoin(runModels, and(eq(runModels.runId, results.runId), eq(runModels.modelId, results.modelId)))
        .where(eq(results.runId, runId))
        .orderBy(asc(results.repetition), asc(runTests.position), asc(runModels.addedAt), asc(models.displayName), asc(results.id));
    },

    /** Médiane historique de `total_ms` des résultats `done`, par modèle (fonction `MEDIAN` de MariaDB). */
    async medianTotalMs(modelIds: string[]): Promise<Map<string, number>> {
      if (modelIds.length === 0) return new Map();
      const rows = await db
        .selectDistinct({
          modelId: results.modelId,
          median: sql<string>`MEDIAN(${results.totalMs}) OVER (PARTITION BY ${results.modelId})`,
        })
        .from(results)
        .where(and(inArray(results.modelId, modelIds), eq(results.status, 'done'), isNotNull(results.totalMs)));
      return new Map(rows.map((r) => [r.modelId, Number(r.median)]));
    },
  };
}

export type RunsRepo = ReturnType<typeof createRunsRepo>;
