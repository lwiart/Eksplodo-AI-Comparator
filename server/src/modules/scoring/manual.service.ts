import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { models } from '../../db/schema/catalog.js';
import { users } from '../../db/schema/core.js';
import { manualScores, results, runModels, runTests, runs } from '../../db/schema/runs.js';
import { NotFoundError, ValidationError } from '../../errors.js';
import type { Actor } from '../auth/actor.js';
import type { DbOrTx } from '../jobs/queue.js';
import { withTxRetry } from '../runs/run-job.js';
import type { TestSnapshot } from '../runs/snapshot.js';
import { readAttachment } from '../tests/attachments.js';

/** Question à noter : un test manuel d'une série, avec l'avancement du compte. */
export type TodoItem = { runTestId: string; runId: string; runName: string; testName: string; answers: number; scoredByMe: number };

/**
 * Question présentée à l'aveugle : ni identifiant de résultat, ni modèle, ni métrique, ni répétition ; les lettres suivent
 * l'ordre propre au compte. `reveal` (lettre → modèle) seulement quand le compte a noté toutes les réponses.
 */
export type BlindQuestion = {
  runTestId: string;
  runName: string;
  testName: string;
  systemPrompt: string | null;
  userPrompt: string;
  attachments: { index: number; originalName: string; mime: string }[];
  answers: { letter: string; responseText: string; myScore: number | null; myComment: string | null }[];
  complete: boolean;
  reveal?: { letter: string; modelName: string; color: string }[];
};

export type ManualScoreInput = { letter: string; score: number; comment?: string };

export type SpreadItem = {
  resultId: string;
  runTestId: string;
  testName: string;
  modelName: string;
  raters: number;
  mean: number | null;
  stdDev: number | null;
  scores: { userName: string; score: number; comment: string | null }[];
};

export type ManualScoringDeps = { db: Db; config: Pick<AppConfig, 'dataDir'> };

const isManualTest = sql`JSON_VALUE(${runTests.snapshot}, '$.scoringMethod') = 'manual'`;
const snapshotName = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${runTests.snapshot}, '$.name'))`;

const questionNotFound = () => new NotFoundError('Question introuvable');

/** Ordre des réponses propre au compte : tri par `sha256(userId + resultId)` (identifiant en départage). */
export function blindOrder(userId: string, resultIds: string[]): string[] {
  return resultIds
    .map((id) => ({ id, key: createHash('sha256').update(userId + id).digest('hex') }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((x) => x.id);
}

/** Lettre de la réponse d'indice `index` : A…Z, puis AA, AB… */
export function letterOf(index: number): string {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Moyenne et écart-type de population (σ sur les évaluateurs), arrondis au centième ; `null` sans note. */
function stats(scores: number[]): { mean: number | null; stdDev: number | null } {
  if (scores.length === 0) return { mean: null, stdDev: null };
  const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
  const variance = scores.reduce((s, x) => s + (x - mean) ** 2, 0) / scores.length;
  return { mean: round2(mean), stdDev: round2(Math.sqrt(variance)) };
}

/**
 * Réponses terminées d'une question et notes déjà données par ce compte : sous-requêtes corrélées à `run_tests`, noms
 * écrits en entier (Drizzle omet le nom de table quand la requête externe n'a qu'une table, d'où des colonnes ambiguës).
 */
const answersCount = sql<number>`(SELECT COUNT(*) FROM results r WHERE r.run_test_id = run_tests.id AND r.status = 'done')`;
const scoredBy = (userId: string) =>
  sql<number>`(SELECT COUNT(*) FROM results r INNER JOIN manual_scores m ON m.result_id = r.id
    WHERE r.run_test_id = run_tests.id AND r.status = 'done' AND m.user_id = ${userId})`;

/** Une question est complète pour un compte quand il a noté toutes ses réponses terminées (au moins une). */
const isComplete = (p: { answers: number; scoredByMe: number }) => p.answers > 0 && p.scoredByMe >= p.answers;

/**
 * Tests manuels de la série dont ce compte n'a pas complété la question : leurs réponses lui restent masquées
 * (`GET /api/runs/:id/results`, export CSV).
 */
export async function incompleteManualQuestions(conn: DbOrTx, userId: string, runId: string): Promise<Set<string>> {
  const rows = await conn
    .select({ runTestId: runTests.id, answers: answersCount.mapWith(Number), scoredByMe: scoredBy(userId).mapWith(Number) })
    .from(runTests)
    .where(and(eq(runTests.runId, runId), isManualTest));
  return new Set(rows.filter((r) => !isComplete(r)).map((r) => r.runTestId));
}

type AnswerRow = { id: string; responseText: string | null; modelName: string; color: string; myScore: number | null; myComment: string | null };

function blindQuestion(
  userId: string,
  rt: { id: string; runName: string; snapshot: TestSnapshot },
  rows: AnswerRow[],
): BlindQuestion {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = blindOrder(userId, rows.map((r) => r.id)).map((id, i) => ({ letter: letterOf(i), row: byId.get(id)! }));
  const complete = rows.length > 0 && rows.every((r) => r.myScore !== null);
  return {
    runTestId: rt.id,
    runName: rt.runName,
    testName: rt.snapshot.name,
    systemPrompt: rt.snapshot.systemPrompt,
    userPrompt: rt.snapshot.userPrompt,
    attachments: rt.snapshot.attachments.map((a, index) => ({ index, originalName: a.originalName, mime: a.mime })),
    answers: ordered.map(({ letter, row }) => ({
      letter,
      responseText: row.responseText ?? '',
      myScore: row.myScore,
      myComment: row.myComment,
    })),
    complete,
    ...(complete ? { reveal: ordered.map(({ letter, row }) => ({ letter, modelName: row.modelName, color: row.color })) } : {}),
  };
}

export function createManualScoringService(deps: ManualScoringDeps) {
  const { db } = deps;

  /** Instantané d'un test manuel de série, ou 404. */
  async function manualRunTest(conn: DbOrTx, runTestId: string) {
    const [rt] = await conn
      .select({ id: runTests.id, snapshot: runTests.snapshot, runName: runs.name })
      .from(runTests)
      .innerJoin(runs, eq(runs.id, runTests.runId))
      .where(eq(runTests.id, runTestId));
    if (!rt || rt.snapshot.scoringMethod !== 'manual') throw questionNotFound();
    return rt;
  }

  async function question(actor: Actor, runTestId: string): Promise<BlindQuestion> {
    const rt = await manualRunTest(db, runTestId);
    const rows = await db
      .select({
        id: results.id,
        responseText: results.responseText,
        modelName: models.displayName,
        color: models.color,
        myScore: manualScores.score,
        myComment: manualScores.comment,
      })
      .from(results)
      .innerJoin(models, eq(models.id, results.modelId))
      .leftJoin(manualScores, and(eq(manualScores.resultId, results.id), eq(manualScores.userId, actor.userId)))
      .where(and(eq(results.runTestId, runTestId), eq(results.status, 'done')));
    return blindQuestion(actor.userId, rt, rows);
  }

  return {
    /** Questions manuelles ayant au moins une réponse terminée et non complètes pour ce compte. */
    async todo(actor: Actor): Promise<{ items: TodoItem[]; count: number }> {
      const rows = await db
        .select({
          runTestId: runTests.id,
          runId: runTests.runId,
          runName: runs.name,
          testName: snapshotName,
          answers: answersCount.mapWith(Number),
          scoredByMe: scoredBy(actor.userId).mapWith(Number),
        })
        .from(runTests)
        .innerJoin(runs, eq(runs.id, runTests.runId))
        .where(isManualTest)
        .orderBy(desc(runs.createdAt), asc(runs.id), asc(runTests.position));
      const items = rows.filter((r) => r.answers > 0 && !isComplete(r));
      return { items, count: items.length };
    },

    question,

    /**
     * Enregistre les notes de toutes les réponses de la question : l'ordre du compte est recalculé sur les réponses
     * terminées (verrouillées), chaque note est insérée ou remplacée, puis le statut de notation des résultats touchés est
     * mis à jour (`done` dès une note, sinon `awaiting_manual`).
     */
    async save(actor: Actor, runTestId: string, scores: ManualScoreInput[]): Promise<BlindQuestion> {
      await withTxRetry(() =>
        db.transaction(async (tx) => {
          await manualRunTest(tx, runTestId);
          const done = await tx
            .select({ id: results.id })
            .from(results)
            .where(and(eq(results.runTestId, runTestId), eq(results.status, 'done')))
            .for('update');
          const idOf = new Map(blindOrder(actor.userId, done.map((r) => r.id)).map((id, i) => [letterOf(i), id]));
          const unknown = scores.find((s) => !idOf.has(s.letter));
          if (unknown) throw new ValidationError('validation', `Lettre inconnue : ${unknown.letter}`);
          if (scores.length !== idOf.size) throw new ValidationError('validation', 'Notez toutes les réponses de la question');
          const ids = scores.map((s) => idOf.get(s.letter)!);
          await tx
            .insert(manualScores)
            .values(
              scores.map((s, i) => ({
                id: randomUUID(),
                resultId: ids[i]!,
                userId: actor.userId,
                score: s.score,
                comment: s.comment === undefined || s.comment === '' ? null : s.comment,
              })),
            )
            .onDuplicateKeyUpdate({
              set: { score: sql.raw('VALUES(`score`)'), comment: sql.raw('VALUES(`comment`)'), updatedAt: sql`CURRENT_TIMESTAMP(3)` },
            });
          await tx
            .update(results)
            .set({
              scoreStatus: sql`CASE WHEN EXISTS (SELECT 1 FROM manual_scores m WHERE m.result_id = results.id)
                THEN 'done' ELSE 'awaiting_manual' END`,
            })
            .where(and(inArray(results.id, ids), eq(results.status, 'done')));
        }),
      );
      return question(actor, runTestId);
    },

    /** Pièce jointe figée dans l'instantané d'une question (indice dans l'instantané). */
    async attachment(runTestId: string, index: number): Promise<{ originalName: string; mime: string; content: Buffer }> {
      const rt = await manualRunTest(db, runTestId);
      const a = rt.snapshot.attachments[index];
      if (!a) throw new NotFoundError('Pièce jointe introuvable');
      try {
        return { originalName: a.originalName, mime: a.mime, content: await readAttachment({ dataDir: deps.config.dataDir }, a) };
      } catch (err) {
        if ((err as { code?: unknown }).code === 'ENOENT') throw new NotFoundError('Pièce jointe introuvable');
        throw err;
      }
    },

    /** Écarts entre évaluateurs (Admin) : chaque réponse terminée d'un test manuel, ses notes, moyenne et écart-type. */
    async spread(runId: string): Promise<{ items: SpreadItem[] }> {
      const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId));
      if (!run) throw new NotFoundError('Série introuvable');
      const [rows, scores] = await Promise.all([
        db
          .select({ resultId: results.id, runTestId: results.runTestId, testName: snapshotName, modelName: models.displayName })
          .from(results)
          .innerJoin(runTests, eq(runTests.id, results.runTestId))
          .innerJoin(models, eq(models.id, results.modelId))
          .innerJoin(runModels, and(eq(runModels.runId, results.runId), eq(runModels.modelId, results.modelId)))
          .where(and(eq(results.runId, runId), eq(results.status, 'done'), isManualTest))
          .orderBy(asc(runTests.position), asc(runModels.addedAt), asc(models.displayName), asc(results.repetition), asc(results.id)),
        db
          .select({ resultId: manualScores.resultId, userName: users.name, score: manualScores.score, comment: manualScores.comment })
          .from(manualScores)
          .innerJoin(results, eq(results.id, manualScores.resultId))
          .innerJoin(users, eq(users.id, manualScores.userId))
          .where(eq(results.runId, runId))
          .orderBy(asc(users.name), asc(manualScores.id)),
      ]);
      const byResult = new Map<string, SpreadItem['scores']>();
      for (const { resultId, ...s } of scores) byResult.set(resultId, [...(byResult.get(resultId) ?? []), s]);
      return {
        items: rows.map((r) => {
          const list = byResult.get(r.resultId) ?? [];
          return { ...r, raters: list.length, ...stats(list.map((s) => s.score)), scores: list };
        }),
      };
    },
  };
}

export type ManualScoringService = ReturnType<typeof createManualScoringService>;
