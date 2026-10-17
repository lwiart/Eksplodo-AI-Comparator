import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { models, providers } from '../../db/schema/catalog.js';
import { results, runModels, runTests, runs } from '../../db/schema/runs.js';
import { NotFoundError } from '../../errors.js';
import type { Actor } from '../auth/actor.js';
import type { ResultStatus } from '../runs/runs.repo.js';
import { maskHiddenRow, resultRowOf, type Weights } from '../runs/runs.service.js';
import type { ScoringMethod } from '../tests/scoring-config.js';
import { aggregateRun, rankModels, type ModelAggregate } from './aggregate.js';
import { csvDocument, csvFileName, type CsvValue } from './csv.js';
import { incompleteManualQuestions } from './manual.service.js';
import { finalScore } from './override.js';

export type RankingModel = ModelAggregate & { name: string; color: string; providerName: string };

/** Notes de critère indépendantes de la pondération (le client pondère) ; modèles dans l'ordre du classement de la série. */
export type Ranking = {
  weights: Weights;
  models: RankingModel[];
  categories: string[];
  judge: { modelName: string } | null;
};

export type Answer = {
  resultId: string;
  modelName: string;
  color: string;
  repetition: number;
  status: ResultStatus;
  responseText: string | null;
  hiddenUntilScored: boolean;
  finalScore: number | null;
  autoScore: number | null;
  manualAvg: number | null;
  overrideScore: number | null;
  judgeRationale: string | null;
  ttftMs: number | null;
  tokensPerS: number | null;
  costUsd: number | null;
  errorMessage: string | null;
};

export type Answers = { test: { name: string; category: string; userPrompt: string }; answers: Answer[] };

const snapshotName = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${runTests.snapshot}, '$.name'))`;
const snapshotCategory = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${runTests.snapshot}, '$.category'))`;
const snapshotMethod = sql<ScoringMethod>`JSON_VALUE(${runTests.snapshot}, '$.scoringMethod')`;
/** Moyenne des évaluateurs du résultat, au centième (nulle sans note) ; nom de table écrit en entier (sous-requête corrélée). */
const manualAvg = sql<number | null>`(SELECT ROUND(AVG(m.score), 2) FROM manual_scores m WHERE m.result_id = results.id)`.mapWith(Number);

const STATUS_LABELS: Record<ResultStatus, string> = {
  pending: 'en attente',
  running: 'en cours',
  done: 'réussi',
  error: 'erreur',
  timeout: 'délai dépassé',
  unsupported: 'non pris en charge',
};

const CSV_HEADER = [
  'série',
  'test',
  'catégorie',
  'modèle',
  'répétition',
  'statut',
  'note finale',
  'note auto',
  'note manuelle (moyenne)',
  'note imposée',
  'premier token (ms)',
  'durée (ms)',
  'tokens/s',
  'tokens entrée',
  'tokens sortie',
  'raisonnement',
  'coût ($)',
  'coût du juge ($)',
  'erreur',
  'réponse',
];

const runNotFound = () => new NotFoundError('Série introuvable');

export function createResultsService(deps: { db: Db }) {
  const { db } = deps;

  async function requireRun(runId: string) {
    const [run] = await db
      .select({ name: runs.name, weights: runs.weights, judgeModelName: models.displayName })
      .from(runs)
      .leftJoin(models, eq(models.id, runs.judgeModelId))
      .where(eq(runs.id, runId));
    if (!run) throw runNotFound();
    return run;
  }

  /** Tests manuels dont ce compte n'a pas complété la question (aucun pour l'Admin). */
  const hiddenFor = (actor: Actor, runId: string) =>
    actor.role === 'admin' ? Promise.resolve(new Set<string>()) : incompleteManualQuestions(db, actor.userId, runId);

  /** Résultats complets avec test, méthode, modèle et moyenne manuelle : par test, modèle (ordre d'ajout), répétition. */
  const detailedRows = (where: SQL | undefined) =>
    db
      .select({
        result: results,
        testName: snapshotName,
        category: snapshotCategory,
        scoringMethod: snapshotMethod,
        modelName: models.displayName,
        color: models.color,
        manualAvg,
      })
      .from(results)
      .innerJoin(runTests, eq(runTests.id, results.runTestId))
      .innerJoin(models, eq(models.id, results.modelId))
      .innerJoin(runModels, and(eq(runModels.runId, results.runId), eq(runModels.modelId, results.modelId)))
      .where(where)
      .orderBy(asc(runTests.position), asc(runModels.addedAt), asc(models.displayName), asc(results.repetition), asc(results.id));

  type DetailedRow = Awaited<ReturnType<typeof detailedRows>>[number];

  /** Ligne d'un compte : texte et métriques masqués sur une question manuelle qu'il n'a pas complétée. */
  const visibleRow = (r: DetailedRow, hidden: Set<string>) => {
    const row = resultRowOf(r);
    return hidden.has(row.runTestId) ? maskHiddenRow(row) : row;
  };

  const finalOf = (r: DetailedRow) =>
    finalScore({ overrideScore: r.result.overrideScore, autoScore: r.result.autoScore, manualAvg: r.manualAvg, method: r.scoringMethod });

  return {
    /** Agrégats par modèle sur toutes les réponses de la série (aucun masquage : un agrégat ne relie aucune lettre à un modèle). */
    async ranking(runId: string): Promise<Ranking> {
      const [run, rows, modelRows, categoryRows] = await Promise.all([
        requireRun(runId),
        db
          .select({
            modelId: results.modelId,
            runTestId: results.runTestId,
            category: snapshotCategory,
            scoringMethod: snapshotMethod,
            status: results.status,
            overrideScore: results.overrideScore,
            autoScore: results.autoScore,
            manualAvg,
            ttftMs: results.ttftMs,
            tokensPerS: results.tokensPerS,
            costUsd: results.costUsd,
          })
          .from(results)
          .innerJoin(runTests, eq(runTests.id, results.runTestId))
          .where(eq(results.runId, runId)),
        db
          .select({ modelId: runModels.modelId, name: models.displayName, color: models.color, providerName: providers.name })
          .from(runModels)
          .innerJoin(models, eq(models.id, runModels.modelId))
          .innerJoin(providers, eq(providers.id, models.providerId))
          .where(eq(runModels.runId, runId))
          .orderBy(asc(runModels.addedAt), asc(models.displayName)),
        db.select({ category: snapshotCategory }).from(runTests).where(eq(runTests.runId, runId)).orderBy(asc(runTests.position)),
      ]);
      const categories = [...new Set(categoryRows.map((r) => r.category))];
      const aggs = new Map(aggregateRun(rows).map((a) => [a.modelId, a]));
      const ordered = modelRows.flatMap((m) => {
        const a = aggs.get(m.modelId);
        return a ? [{ ...a, ...m }] : [];
      });
      const position = new Map(rankModels(ordered, run.weights).map((r, i) => [r.modelId, i]));
      return {
        weights: run.weights,
        models: ordered.sort((a, b) => position.get(a.modelId)! - position.get(b.modelId)!),
        categories,
        judge: run.judgeModelName === null ? null : { modelName: run.judgeModelName },
      };
    },

    /** Réponses côte à côte d'un test de la série, avec les mêmes règles de masquage que `GET /api/runs/:id/results`. */
    async answers(runId: string, runTestId: string, actor: Actor): Promise<Answers> {
      const [[rt], rows, hidden] = await Promise.all([
        db
          .select({ snapshot: runTests.snapshot })
          .from(runTests)
          .where(and(eq(runTests.id, runTestId), eq(runTests.runId, runId))),
        detailedRows(and(eq(results.runId, runId), eq(results.runTestId, runTestId))),
        hiddenFor(actor, runId),
      ]);
      if (!rt) throw new NotFoundError('Test introuvable dans cette série');
      return {
        test: { name: rt.snapshot.name, category: rt.snapshot.category, userPrompt: rt.snapshot.userPrompt },
        answers: rows.map((r) => {
          const row = visibleRow(r, hidden);
          return {
            resultId: row.id,
            modelName: row.modelName,
            color: row.color,
            repetition: row.repetition,
            status: row.status,
            responseText: row.responseText,
            hiddenUntilScored: row.hiddenUntilScored,
            finalScore: finalOf(r),
            autoScore: r.result.autoScore,
            manualAvg: r.manualAvg,
            overrideScore: r.result.overrideScore,
            judgeRationale: r.result.judgeRationale,
            ttftMs: row.ttftMs,
            tokensPerS: row.tokensPerS,
            costUsd: row.costUsd,
            errorMessage: row.errorMessage,
          };
        }),
      };
    },

    /** Export CSV : une ligne par résultat, mêmes règles de masquage que `GET /api/runs/:id/results`. */
    async exportCsv(runId: string, actor: Actor): Promise<{ fileName: string; body: string }> {
      const [run, rows, hidden] = await Promise.all([requireRun(runId), detailedRows(eq(results.runId, runId)), hiddenFor(actor, runId)]);
      const lines: CsvValue[][] = rows.map((r) => {
        const row = visibleRow(r, hidden);
        return [
          run.name,
          row.testName,
          row.category,
          row.modelName,
          row.repetition,
          STATUS_LABELS[row.status],
          finalOf(r),
          r.result.autoScore,
          r.manualAvg,
          r.result.overrideScore,
          row.ttftMs,
          row.totalMs,
          row.tokensPerS,
          row.inputTokens,
          row.outputTokens,
          row.reasoningTokens,
          row.costUsd,
          r.result.judgeCostUsd,
          row.errorMessage,
          row.responseText,
        ];
      });
      return { fileName: csvFileName(run.name), body: csvDocument([CSV_HEADER, ...lines]) };
    },
  };
}

export type ResultsService = ReturnType<typeof createResultsService>;
