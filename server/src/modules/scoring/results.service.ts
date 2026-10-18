import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { models, providers } from '../../db/schema/catalog.js';
import { results, runModels, runTests, runs } from '../../db/schema/runs.js';
import { NotFoundError } from '../../errors.js';
import { readAttachment } from '../tests/attachments.js';
import type { Actor } from '../auth/actor.js';
import type { ResultStatus } from '../runs/runs.repo.js';
import { maskHiddenRow, resultRowOf, type ResultRow, type Weights } from '../runs/runs.service.js';
import type { ScoringMethod } from '../tests/scoring-config.js';
import { aggregateRun, rankModels, type AggregateInputRow, type ModelAggregate } from './aggregate.js';
import { csvDocument, csvFileName, type CsvValue } from './csv.js';
import { incompleteManualQuestions, incompleteManualQuestionsIn } from './manual.service.js';
import { finalScore } from './override.js';
import { buildRunWorkbook, xlsxFileName } from './xlsx.js';

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

/** `scoringMethod` : le client ne propose la relance du juge que sur un test noté par le juge. */
/** Pièce jointe de l'instantané, repérée par sa position (ni identifiant ni chemin de stockage). */
export type AnswerAttachment = { index: number; originalName: string; mime: string; pages: number | null };
export type Answers = {
  test: { name: string; category: string; userPrompt: string; scoringMethod: ScoringMethod; attachments: AnswerAttachment[] };
  answers: Answer[];
};

const snapshotName = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${runTests.snapshot}, '$.name'))`;
const snapshotCategory = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${runTests.snapshot}, '$.category'))`;
const snapshotMethod = sql<ScoringMethod>`JSON_VALUE(${runTests.snapshot}, '$.scoringMethod')`;
/** Moyenne des évaluateurs du résultat, au centième (nulle sans note) ; nom de table écrit en entier (sous-requête corrélée). */
export const manualAvg = sql<number | null>`(SELECT ROUND(AVG(m.score), 2) FROM manual_scores m WHERE m.result_id = results.id)`.mapWith(Number);

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

/** Cellule « réponse » d'une question manuelle que le compte n'a pas encore notée. */
const HIDDEN_RESPONSE = "(masquée jusqu'à notation)";

/** Résultats de plusieurs séries réduits à ce que l'agrégation lit (une seule requête), avec la série d'origine. */
export async function loadAggregateRows(db: Db, runIds: string[]): Promise<(AggregateInputRow & { runId: string })[]> {
  if (runIds.length === 0) return [];
  return db
    .select({
      runId: results.runId,
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
    .where(inArray(results.runId, runIds));
}

/**
 * Questions manuelles masquées à ce compte dans ces séries (aucune pour l'Admin) : celles qu'il n'a pas encore complétées.
 * Les identifiants de `run_tests` étant propres à une série, un seul ensemble couvre plusieurs séries.
 */
export function hiddenQuestionsFor(conn: Db, actor: Actor, runIds: string[]): Promise<Set<string>> {
  return actor.role === 'admin' ? Promise.resolve(new Set<string>()) : incompleteManualQuestionsIn(conn, actor.userId, runIds);
}

/**
 * Lignes d'agrégation vues par un compte : sur une question manuelle masquée, moyenne des évaluateurs et note imposée
 * retirées (test non noté pour lui), sans quoi un agrégat par catégorie révélerait les notes des autres évaluateurs.
 */
export function withoutHiddenScores<T extends { runTestId: string; manualAvg: number | null; overrideScore: number | null }>(
  rows: T[],
  hidden: Set<string>,
): T[] {
  if (hidden.size === 0) return rows;
  return rows.map((r) => (hidden.has(r.runTestId) ? { ...r, manualAvg: null, overrideScore: null } : r));
}

const runNotFound = () => new NotFoundError('Série introuvable');

export function createResultsService(deps: { db: Db; config: { dataDir: string } }) {
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

  type Scores = {
    finalScore: number | null;
    autoScore: number | null;
    manualAvg: number | null;
    overrideScore: number | null;
    judgeRationale: string | null;
    judgeCostUsd: number | null;
  };
  const NO_SCORES: Scores = { finalScore: null, autoScore: null, manualAvg: null, overrideScore: null, judgeRationale: null, judgeCostUsd: null };

  /**
   * Ligne d'un compte : sur une question manuelle qu'il n'a pas complétée, texte, métriques et notes masqués (les notes des
   * autres évaluateurs ne doivent pas orienter sa notation à l'aveugle).
   */
  const visibleRow = (r: DetailedRow, hidden: Set<string>): { row: ResultRow; scores: Scores } => {
    const row = resultRowOf(r);
    if (hidden.has(row.runTestId)) return { row: maskHiddenRow(row), scores: NO_SCORES };
    const { overrideScore, autoScore, judgeRationale, judgeCostUsd } = r.result;
    return {
      row,
      scores: {
        finalScore: finalScore({ overrideScore, autoScore, manualAvg: r.manualAvg, method: r.scoringMethod }),
        autoScore,
        manualAvg: r.manualAvg,
        overrideScore,
        judgeRationale,
        judgeCostUsd,
      },
    };
  };

  /** Lignes de l'export (CSV et feuille Résultats) : une par résultat, mêmes règles de masquage que `GET /api/runs/:id/results`. */
  async function exportLines(runId: string, actor: Actor): Promise<{ run: { name: string }; lines: CsvValue[][] }> {
    const [run, rows, hidden] = await Promise.all([requireRun(runId), detailedRows(eq(results.runId, runId)), hiddenFor(actor, runId)]);
    const lines: CsvValue[][] = rows.map((r) => {
      const { row, scores } = visibleRow(r, hidden);
      return [
        run.name,
        row.testName,
        row.category,
        row.modelName,
        row.repetition,
        STATUS_LABELS[row.status],
        scores.finalScore,
        scores.autoScore,
        scores.manualAvg,
        scores.overrideScore,
        row.ttftMs,
        row.totalMs,
        row.tokensPerS,
        row.inputTokens,
        row.outputTokens,
        row.reasoningTokens,
        row.costUsd,
        scores.judgeCostUsd,
        row.errorMessage,
        row.hiddenUntilScored ? HIDDEN_RESPONSE : row.responseText,
      ];
    });
    return { run, lines };
  }

  const service = {
    /**
     * Agrégats par modèle sur toutes les réponses de la série. Pour un Utilisateur, les notes des questions manuelles qu'il
     * n'a pas complétées sont retirées : la qualité par catégorie d'un test manuel seul dans sa catégorie serait sinon la
     * moyenne des autres évaluateurs pour ce modèle.
     */
    async ranking(runId: string, actor: Actor): Promise<Ranking> {
      const [run, rows, modelRows, categoryRows, hidden] = await Promise.all([
        requireRun(runId),
        loadAggregateRows(db, [runId]),
        db
          .select({ modelId: runModels.modelId, name: models.displayName, color: models.color, providerName: providers.name })
          .from(runModels)
          .innerJoin(models, eq(models.id, runModels.modelId))
          .innerJoin(providers, eq(providers.id, models.providerId))
          .where(eq(runModels.runId, runId))
          .orderBy(asc(runModels.addedAt), asc(models.displayName)),
        db.select({ category: snapshotCategory }).from(runTests).where(eq(runTests.runId, runId)).orderBy(asc(runTests.position)),
        hiddenFor(actor, runId),
      ]);
      const categories = [...new Set(categoryRows.map((r) => r.category))];
      const aggs = new Map(aggregateRun(withoutHiddenScores(rows, hidden)).map((a) => [a.modelId, a]));
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
        test: {
          name: rt.snapshot.name,
          category: rt.snapshot.category,
          userPrompt: rt.snapshot.userPrompt,
          scoringMethod: rt.snapshot.scoringMethod,
          attachments: (rt.snapshot.attachments ?? []).map((a, index) => ({ index, originalName: a.originalName, mime: a.mime, pages: a.pages ?? null })),
        },
        answers: rows.map((r) => {
          const { row, scores } = visibleRow(r, hidden);
          return {
            resultId: row.id,
            modelName: row.modelName,
            color: row.color,
            repetition: row.repetition,
            status: row.status,
            responseText: row.responseText,
            hiddenUntilScored: row.hiddenUntilScored,
            finalScore: scores.finalScore,
            autoScore: scores.autoScore,
            manualAvg: scores.manualAvg,
            overrideScore: scores.overrideScore,
            judgeRationale: scores.judgeRationale,
            ttftMs: row.ttftMs,
            tokensPerS: row.tokensPerS,
            costUsd: row.costUsd,
            errorMessage: row.errorMessage,
          };
        }),
      };
    },

    /** Pièce jointe n° `index` de l'instantané d'un test de la série (mêmes droits que `answers`). */
    async attachment(runId: string, runTestId: string, index: number): Promise<{ originalName: string; mime: string; content: Buffer }> {
      const [rt] = await db
        .select({ snapshot: runTests.snapshot })
        .from(runTests)
        .where(and(eq(runTests.id, runTestId), eq(runTests.runId, runId)));
      const a = rt?.snapshot.attachments?.[index];
      if (!a) throw new NotFoundError('Pièce jointe introuvable');
      try {
        return { originalName: a.originalName, mime: a.mime, content: await readAttachment({ dataDir: deps.config.dataDir }, a) };
      } catch (err) {
        if ((err as { code?: unknown }).code === 'ENOENT') throw new NotFoundError('Pièce jointe introuvable');
        throw err;
      }
    },

    /** Export CSV : une ligne par résultat, mêmes règles de masquage que `GET /api/runs/:id/results`. */
    async exportCsv(runId: string, actor: Actor): Promise<{ fileName: string; body: string }> {
      const { run, lines } = await exportLines(runId, actor);
      return { fileName: csvFileName(run.name), body: csvDocument([CSV_HEADER, ...lines]) };
    },

    /**
     * Export XLSX : classement (celui de `ranking`, pondération de la série), lignes du CSV typées et définitions des
     * critères ; mêmes règles de masquage que le classement et le CSV.
     */
    async exportXlsx(runId: string, actor: Actor): Promise<{ fileName: string; body: Buffer }> {
      const [{ run, lines }, rank] = await Promise.all([exportLines(runId, actor), service.ranking(runId, actor)]);
      const body = await buildRunWorkbook({
        runName: run.name,
        weights: rank.weights,
        models: rank.models,
        resultHeader: CSV_HEADER,
        resultLines: lines,
      });
      return { fileName: xlsxFileName(run.name), body };
    },
  };
  return service;
}

export type ResultsService = ReturnType<typeof createResultsService>;
