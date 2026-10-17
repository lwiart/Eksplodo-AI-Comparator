import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { models, providers } from '../../db/schema/catalog.js';
import { results, runModels, runTests, runs, type RunWeights } from '../../db/schema/runs.js';
import { suiteTests, suites, testAttachments, tests } from '../../db/schema/tests.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import type { Clock } from '../../lib/clock.js';
import { audit } from '../audit/audit.js';
import type { Actor } from '../auth/actor.js';
import { affectedRows, type DbOrTx } from '../jobs/queue.js';
import type { Registry } from '../providers/registry.js';
import {
  countPendingJudgements,
  judgeCallMaxCostUsd,
  judgeInputTokens,
  loadPendingJudgements,
  loadRunJudge,
} from '../scoring/judge-items.js';
import { incompleteManualQuestions } from '../scoring/manual.service.js';
import { rescore, type RescoreInput } from '../scoring/rescore.js';
import type { PublicTest } from '../tests/tests.service.js';
import type { TestRow } from '../tests/tests.repo.js';
import { roundUsd } from './engine.js';
import { estimateRun, isSupported, maxCallCostUsd, type ModelForEstimate, type RunEstimate } from './estimate.js';
import { ACTIVITY_LIMIT, buildProgress, countsOf, type RunProgress, type StatusCounts } from './progress.js';
import { enqueueRunJob, withTxRetry } from './run-job.js';
import { createRunsRepo, type ResultStatus, type RunRow } from './runs.repo.js';
import { snapshotOf, type TestSnapshot } from './snapshot.js';

export type Weights = RunWeights;

export const DEFAULT_WEIGHTS: Weights = { quality: 50, speed: 20, cost: 20, reliability: 10 };

/** Appels au plus dans une série (tests × modèles × répétitions). */
export const MAX_RUN_CALLS = 5_000;

export type RunInput = {
  name: string;
  /** Suite d'origine : les tests sont alors rangés dans l'ordre de la suite. */
  suiteId?: string;
  /** Tests dans l'ordre voulu (sans suite). */
  testIds: string[];
  modelIds: string[];
  repetitions: number;
  concurrency: number;
  judgeModelId?: string | null;
  budgetUsd?: number | null;
  weights?: Weights;
};

export type RunSummary = {
  id: string;
  name: string;
  status: RunRow['status'];
  pauseReason: RunRow['pauseReason'];
  suiteName: string | null;
  modelCount: number;
  testCount: number;
  repetitions: number;
  judgeModelName: string | null;
  modelsCostUsd: number;
  judgeCostUsd: number;
  budgetUsd: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  counts: StatusCounts;
};

/** Modification d'une série : plafond (`null` : sans plafond) et pondération par défaut. */
export type RunPatch = { budgetUsd?: number | null; weights?: Weights };

export type ResultRow = {
  id: string;
  runTestId: string;
  testName: string;
  category: string;
  modelId: string;
  modelName: string;
  color: string;
  repetition: number;
  status: ResultStatus;
  attempts: number;
  responseText: string | null;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  tokensEstimated: boolean;
  ttftMs: number | null;
  totalMs: number | null;
  tokensPerS: number | null;
  costUsd: number | null;
  costSource: 'computed' | 'provider' | null;
  errorCode: string | null;
  errorMessage: string | null;
  scoreStatus: 'pending' | 'done' | 'awaiting_manual' | 'judge_failed';
  completedAt: string | null;
  /** Réponse masquée (`responseText` nul) : test manuel dont l'Utilisateur n'a pas encore noté la question. */
  hiddenUntilScored: boolean;
};

export type RunsServiceDeps = {
  db: Db;
  clock: Clock;
  registry: Registry;
  config: Pick<AppConfig, 'dataDir'>;
};

export type CandidateModel = Omit<ModelForEstimate, 'medianTotalMs'> & { available: boolean };

const runNotFound = () => new NotFoundError('Série introuvable');
const testNotFound = () => new ValidationError('test_not_found', 'Un des tests demandés est introuvable ou archivé');
const suiteNotFound = () => new ValidationError('suite_not_found', 'Suite introuvable');
const modelUnavailable = () =>
  new ConflictError('model_unavailable', 'Un des modèles demandés est indisponible (inactif, ou fournisseur sans clé utilisable)');
const judgeRequired = () => new ValidationError('judge_required', 'Un modèle juge est requis : la sélection contient des tests notés par le juge');
const runNotActive = () => new ConflictError('run_not_active', 'La série n\'est pas en cours : rien à mettre en pause');
const runNotPaused = () => new ConflictError('run_not_paused', 'La série n\'est ni en pause ni interrompue');
const runTooLarge = () => new ValidationError('run_too_large', 'Série trop grande : 5 000 appels au plus');
const budgetExceeded = () =>
  new ConflictError(
    'budget_exceeded',
    'Plafond de dépense insuffisant : relevez-le au moins à la dépense plus le coût maximal du prochain appel avant de reprendre',
  );

/** Coût maximal du prochain appel du juge : la moins chère des notes du juge en attente ; `null` sans note à rendre. */
async function nextJudgeCallMaxCostUsd(conn: DbOrTx, runId: string): Promise<number | null> {
  const [run] = await conn.select({ judgeModelId: runs.judgeModelId }).from(runs).where(eq(runs.id, runId));
  const pending = await loadPendingJudgements(conn, runId);
  if (!run || pending.length === 0) return null;
  const { judge } = await loadRunJudge(conn, run.judgeModelId);
  if (judge === null) return null; // juge indisponible : notes mises en échec par le moteur, sans appel
  return Math.min(...pending.map((p) => judgeCallMaxCostUsd(judgeInputTokens(p.snapshot, p.responseChars, judge), judge.prices)));
}

/**
 * Coût maximal du prochain appel : le moins cher des résultats en attente et des notes du juge en attente (même règle que
 * le moteur, qui lance le premier appel qui tient) ; `null` sans appel restant.
 */
export async function nextCallMaxCostUsd(conn: DbOrTx, runId: string): Promise<number | null> {
  const [generation, judge] = await Promise.all([nextGenerationMaxCostUsd(conn, runId), nextJudgeCallMaxCostUsd(conn, runId)]);
  if (generation === null) return judge;
  return judge === null ? generation : Math.min(generation, judge);
}

/** Coût maximal du prochain appel de génération : le moins cher des résultats en attente ; `null` sans résultat en attente. */
async function nextGenerationMaxCostUsd(conn: DbOrTx, runId: string): Promise<number | null> {
  const pending = await conn
    .selectDistinct({ runTestId: results.runTestId, modelId: results.modelId })
    .from(results)
    .where(and(eq(results.runId, runId), eq(results.status, 'pending')));
  if (pending.length === 0) return null;
  const [snapshots, prices] = await Promise.all([
    conn.select({ id: runTests.id, snapshot: runTests.snapshot }).from(runTests).where(eq(runTests.runId, runId)),
    conn
      .select({ id: models.id, inputPricePerM: models.inputPricePerM, outputPricePerM: models.outputPricePerM })
      .from(models)
      .where(inArray(models.id, [...new Set(pending.map((p) => p.modelId))])),
  ]);
  const snapshotOf = new Map(snapshots.map((s) => [s.id, s.snapshot]));
  const pricesOf = new Map(prices.map((p) => [p.id, p]));
  return Math.min(...pending.map((p) => maxCallCostUsd(snapshotOf.get(p.runTestId)!, pricesOf.get(p.modelId)!)));
}

/**
 * Résultats d'une série pour ces modèles : par répétition, test puis modèle ; les combinaisons non supportées directement
 * en `unsupported`.
 */
function resultRowsFor(
  runId: string,
  repetitions: number,
  runTestRows: { id: string; snapshot: TestSnapshot }[],
  chosen: CandidateModel[],
): (typeof results.$inferInsert)[] {
  const rows: (typeof results.$inferInsert)[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const rt of runTestRows) {
      for (const m of chosen) {
        const supported = isSupported(rt.snapshot, m);
        rows.push({
          id: randomUUID(),
          runId,
          runTestId: rt.id,
          modelId: m.id,
          repetition,
          status: supported ? 'pending' : 'unsupported',
          // Un résultat non supporté garde `pending` : la notation l'ignore.
          scoreStatus: supported && rt.snapshot.scoringMethod === 'manual' ? 'awaiting_manual' : 'pending',
        });
      }
    }
  }
  return rows;
}

/** Refuse une série de plus de `MAX_RUN_CALLS` appels, avant toute lecture. */
function assertRunSize(input: Pick<RunInput, 'testIds' | 'modelIds' | 'repetitions'>): void {
  if (input.testIds.length * input.modelIds.length * input.repetitions > MAX_RUN_CALLS) throw runTooLarge();
}

/** Vue minimale d'une ligne de test attendue par `snapshotOf` (seuls les champs du test sont repris). */
function testView(row: TestRow): Omit<PublicTest, 'attachments'> {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    tags: row.tags,
    systemPrompt: row.systemPrompt,
    userPrompt: row.userPrompt,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    scoringMethod: row.scoringMethod,
    scoringConfig: row.scoringConfig,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    usedInRuns: 0, // non repris dans l'instantané
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Instantanés des tests, dans l'ordre de `testIds` ; test inconnu ou archivé → `test_not_found`.
 * `lock` (création) : lignes des tests verrouillées (`FOR UPDATE`, comme le retrait d'une pièce jointe) et pièces
 * jointes lues en lecture courante (`FOR UPDATE` : MariaDB n'accepte pas `FOR SHARE`). Une lecture ordinaire verrait l'image figée par une lecture antérieure
 * de la transaction (REPEATABLE READ), éventuellement d'avant un retrait validé entre-temps.
 */
export async function snapshotTests(conn: DbOrTx, testIds: string[], lock: boolean): Promise<TestSnapshot[]> {
  const testsQuery = conn.select().from(tests).where(inArray(tests.id, testIds));
  const rows = lock ? await testsQuery.for('update') : await testsQuery;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = testIds.map((id) => byId.get(id));
  if (ordered.some((r) => r === undefined || r.archivedAt !== null)) throw testNotFound();
  const attachmentsQuery = conn
    .select()
    .from(testAttachments)
    .where(and(inArray(testAttachments.testId, testIds), isNull(testAttachments.deletedAt)))
    .orderBy(asc(testAttachments.createdAt), asc(testAttachments.id));
  const attachments = lock ? await attachmentsQuery.for('update') : await attachmentsQuery;
  return ordered.map((r) =>
    snapshotOf(
      testView(r!),
      attachments.filter((a) => a.testId === r!.id),
    ),
  );
}

/** Modèles demandés avec leur disponibilité (modèle et fournisseur actifs, clé utilisable). */
export async function candidateModelsOf(
  conn: DbOrTx,
  registry: Pick<Registry, 'keyStatus'>,
  ids: string[],
): Promise<Map<string, CandidateModel>> {
  if (ids.length === 0) return new Map();
  const rows = await conn
    .select({ model: models, provider: providers })
    .from(models)
    .innerJoin(providers, eq(providers.id, models.providerId))
    .where(inArray(models.id, ids));
  return new Map(
    rows.map(({ model: m, provider: p }) => [
      m.id,
      {
        id: m.id,
        name: m.displayName,
        inputPricePerM: m.inputPricePerM,
        outputPricePerM: m.outputPricePerM,
        supportsVision: m.supportsVision,
        supportsPdf: m.supportsPdf,
        available: m.enabled && p.enabled && registry.keyStatus(p).usable,
      },
    ]),
  );
}

export function createRunsService(deps: RunsServiceDeps) {
  const { db, registry } = deps;
  const repo = createRunsRepo(db);

  /** Avec une suite : ordre des positions de la suite (tests hors suite à la suite, dans l'ordre donné). */
  async function orderedTestIds(conn: DbOrTx, input: RunInput): Promise<string[]> {
    if (input.suiteId === undefined) return input.testIds;
    const [suite] = await conn.select({ id: suites.id }).from(suites).where(eq(suites.id, input.suiteId));
    if (!suite) throw suiteNotFound();
    const members = await conn
      .select({ testId: suiteTests.testId, position: suiteTests.position })
      .from(suiteTests)
      .where(eq(suiteTests.suiteId, input.suiteId));
    const position = new Map(members.map((m) => [m.testId, m.position]));
    return input.testIds
      .map((id, index) => ({ id, index, position: position.get(id) ?? Number.POSITIVE_INFINITY }))
      .sort((a, b) => a.position - b.position || a.index - b.index)
      .map((x) => x.id);
  }

  const candidateModels = (conn: DbOrTx, ids: string[]) => candidateModelsOf(conn, registry, ids);

  /** Valide la demande : tests actifs, modèles disponibles, juge requis et disponible. */
  async function resolve(conn: DbOrTx, input: RunInput, lock: boolean) {
    // Tests verrouillés avant toute autre lecture (suite, modèles) : l'image de la transaction est prise après le verrou.
    const byTest = new Map((await snapshotTests(conn, input.testIds, lock)).map((snap) => [snap.testId, snap]));
    const snapshots = (await orderedTestIds(conn, input)).map((id) => byTest.get(id)!);
    const judgeId = input.judgeModelId ?? null;
    const found = await candidateModels(conn, judgeId === null ? input.modelIds : [...input.modelIds, judgeId]);
    const chosen = input.modelIds.map((id) => found.get(id));
    if (chosen.some((m) => !m?.available)) throw modelUnavailable();
    if (judgeId === null && snapshots.some((s) => s.scoringMethod === 'judge')) throw judgeRequired();
    const judge = judgeId === null ? null : found.get(judgeId);
    if (judge !== null && !judge?.available) throw modelUnavailable();
    return { snapshots, models: chosen as CandidateModel[], judge: judge as CandidateModel | null };
  }

  async function summaries(id?: string): Promise<RunSummary[]> {
    const rows = await repo.listRuns(id);
    const ids = rows.map((r) => r.run.id);
    const [sizes, counts] = await Promise.all([repo.sizes(ids), repo.statusCounts(ids)]);
    return rows.map(({ run, suiteName, judgeModelName }) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      pauseReason: run.pauseReason,
      suiteName,
      modelCount: sizes.get(run.id)?.modelCount ?? 0,
      testCount: sizes.get(run.id)?.testCount ?? 0,
      repetitions: run.repetitions,
      judgeModelName,
      modelsCostUsd: run.modelsCostUsd,
      judgeCostUsd: run.judgeCostUsd,
      budgetUsd: run.budgetUsd,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      counts: countsOf(counts.filter((c) => c.runId === run.id)),
    }));
  }

  async function requireRun(id: string): Promise<RunRow> {
    const [row] = await repo.listRuns(id);
    if (!row) throw runNotFound();
    return row.run;
  }

  async function summaryOf(id: string): Promise<RunSummary> {
    const [summary] = await summaries(id);
    if (!summary) throw runNotFound();
    return summary;
  }

  /**
   * Écriture courte sous verrou de la ligne `runs` (comme la transaction finale du moteur, qui compte alors les résultats
   * restants de façon cohérente), rejouée sur conflit d'instantané ou interblocage.
   */
  function withLockedRun<T>(id: string, fn: (tx: DbOrTx, run: RunRow) => Promise<T>): Promise<T> {
    return withTxRetry(() =>
      db.transaction(async (tx) => {
        const [run] = await tx.select().from(runs).where(eq(runs.id, id)).for('update');
        if (!run) throw runNotFound();
        return fn(tx, run);
      }),
    );
  }

  /** Remet la série en file : `queued` si elle était arrêtée (pause, fin, interruption), puis sa tâche unique. */
  async function requeue(tx: DbOrTx, run: RunRow, now: Date): Promise<void> {
    if (run.status !== 'queued' && run.status !== 'running') {
      await tx.update(runs).set({ status: 'queued', pauseReason: null, completedAt: null }).where(eq(runs.id, run.id));
    }
    await enqueueRunJob(tx, run.id, now);
  }

  const auditRun = (tx: DbOrTx, actor: Actor, action: string, runId: string, details?: unknown) =>
    audit(tx, { actorUserId: actor.userId, action, targetType: 'run', targetId: runId, ...(details === undefined ? {} : { details }) });

  return {
    /** Estimation du coût maximal et de la durée, sans rien créer. */
    async estimate(input: RunInput): Promise<RunEstimate> {
      assertRunSize(input);
      const { snapshots, models: chosen, judge } = await resolve(db, input, false);
      const medians = await repo.medianTotalMs(chosen.map((m) => m.id)); // la durée ne compte que les modèles évalués
      const forEstimate = ({ available: _available, ...m }: CandidateModel): ModelForEstimate => ({
        ...m,
        medianTotalMs: medians.get(m.id) ?? null,
      });
      return estimateRun({
        tests: snapshots,
        models: chosen.map(forEstimate),
        repetitions: input.repetitions,
        concurrency: input.concurrency,
        judge: judge ? forEstimate(judge) : null,
      });
    },

    /**
     * Crée la série dans une transaction : série `queued`, modèles, instantanés des tests, tous les résultats (les
     * combinaisons non supportées directement en `unsupported`), puis sa tâche `run_execute`. Transaction rejouée sur
     * conflit d'instantané ou interblocage.
     */
    async create(actor: Actor, input: RunInput): Promise<RunSummary> {
      assertRunSize(input);
      const runId = randomUUID();
      const now = deps.clock();
      await withTxRetry(() =>
        db.transaction(async (tx) => {
          const { snapshots, models: chosen, judge } = await resolve(tx, input, true);
          await repo.insertRun(tx, {
            id: runId,
            name: input.name,
            suiteId: input.suiteId ?? null,
            judgeModelId: judge?.id ?? null,
            repetitions: input.repetitions,
            concurrency: input.concurrency,
            budgetUsd: input.budgetUsd ?? null,
            status: 'queued',
            weights: input.weights ?? DEFAULT_WEIGHTS,
            createdBy: actor.userId,
            createdAt: now,
          });
          await repo.insertRunModels(
            tx,
            chosen.map((m) => ({ runId, modelId: m.id, addedAt: now })),
          );
          const runTestRows = snapshots.map((snapshot, position) => ({
            id: randomUUID(),
            runId,
            testId: snapshot.testId,
            position,
            snapshot,
          }));
          await repo.insertRunTests(tx, runTestRows);
          await repo.insertResults(tx, resultRowsFor(runId, input.repetitions, runTestRows, chosen));
          await enqueueRunJob(tx, runId, now);
          await audit(tx, {
            actorUserId: actor.userId,
            action: 'run_created',
            targetType: 'run',
            targetId: runId,
            details: {
              name: input.name,
              tests: snapshots.length,
              models: chosen.length,
              repetitions: input.repetitions,
              judgeModelId: judge?.id ?? null,
            },
          });
        }),
      );
      return (await summaries(runId))[0]!;
    },

    list: () => summaries(),

    get: summaryOf,

    /** Pause demandée : la tâche ne lance plus d'appel, laisse finir ceux en cours puis se retire. */
    async pause(actor: Actor, id: string): Promise<RunSummary> {
      await withLockedRun(id, async (tx, run) => {
        if (run.status !== 'queued' && run.status !== 'running') throw runNotActive();
        await tx.update(runs).set({ status: 'paused', pauseReason: 'user' }).where(eq(runs.id, id));
        await auditRun(tx, actor, 'run_paused', id);
      });
      return summaryOf(id);
    },

    /**
     * Reprise d'une série en pause ou interrompue ; après une pause `budget`, le plafond doit couvrir la dépense plus le
     * coût maximal du prochain appel en attente (le moins cher).
     */
    async resume(actor: Actor, id: string): Promise<RunSummary> {
      await withLockedRun(id, async (tx, run) => {
        if (run.status !== 'paused' && run.status !== 'interrupted') throw runNotPaused();
        if (run.status === 'paused' && run.pauseReason === 'budget' && run.budgetUsd !== null) {
          // Même règle que le moteur avant un lancement : le prochain appel (le moins cher) doit tenir sous le plafond.
          const nextUsd = (await nextCallMaxCostUsd(tx, id)) ?? 0;
          if (roundUsd(run.modelsCostUsd + run.judgeCostUsd + nextUsd) > run.budgetUsd) throw budgetExceeded();
        }
        await requeue(tx, run, deps.clock());
        await auditRun(tx, actor, 'run_resumed', id, { from: run.status, pauseReason: run.pauseReason });
      });
      return summaryOf(id);
    },

    /** Résultats `error` et `timeout` remis en attente (tentatives remises à zéro), puis reprise de la série. */
    async retryErrors(actor: Actor, id: string): Promise<RunSummary> {
      await withLockedRun(id, async (tx, run) => {
        const res = await tx
          .update(results)
          .set({ status: 'pending', attempts: 0, errorCode: null, errorMessage: null, completedAt: null })
          .where(and(eq(results.runId, id), inArray(results.status, ['error', 'timeout'])));
        const count = affectedRows(res);
        if (count === 0) return;
        await requeue(tx, run, deps.clock());
        await auditRun(tx, actor, 'run_errors_retried', id, { count });
      });
      return summaryOf(id);
    },

    /**
     * Ajoute des modèles à la série : `run_models` et résultats manquants (non supportés en `unsupported`), puis reprise.
     * Les modèles déjà présents sont ignorés ; un nouveau modèle indisponible refuse tout l'ajout.
     */
    async addModels(actor: Actor, id: string, modelIds: string[]): Promise<RunSummary> {
      const now = deps.clock();
      await withLockedRun(id, async (tx, run) => {
        const present = await tx.select({ modelId: runModels.modelId }).from(runModels).where(eq(runModels.runId, id));
        const known = new Set(present.map((r) => r.modelId));
        const newIds = modelIds.filter((m) => !known.has(m));
        if (newIds.length === 0) return;
        const found = await candidateModels(tx, newIds);
        const chosen = newIds.map((m) => found.get(m));
        if (chosen.some((m) => !m?.available)) throw modelUnavailable();
        await repo.insertRunModels(
          tx,
          newIds.map((modelId) => ({ runId: id, modelId, addedAt: now })),
        );
        const runTestRows = await tx
          .select({ id: runTests.id, snapshot: runTests.snapshot })
          .from(runTests)
          .where(eq(runTests.runId, id))
          .orderBy(asc(runTests.position));
        await repo.insertResults(tx, resultRowsFor(id, run.repetitions, runTestRows, chosen as CandidateModel[]));
        await requeue(tx, run, now);
        await auditRun(tx, actor, 'run_models_added', id, { modelIds: newIds });
      });
      return summaryOf(id);
    },

    /** Plafond et pondération par défaut ; relever le plafond ne reprend pas une série en pause. */
    async update(actor: Actor, id: string, patch: RunPatch): Promise<RunSummary> {
      await withLockedRun(id, async (tx) => {
        const values = {
          ...(patch.budgetUsd === undefined ? {} : { budgetUsd: patch.budgetUsd }),
          ...(patch.weights === undefined ? {} : { weights: patch.weights }),
        };
        if (Object.keys(values).length === 0) return;
        await tx.update(runs).set(values).where(eq(runs.id, id));
        await auditRun(tx, actor, 'run_updated', id, patch);
      });
      return summaryOf(id);
    },

    /** Recalcul des notes du juge (série, test ou résultat), éventuellement avec un autre juge. */
    rescore: (actor: Actor, id: string, input: RescoreInput) => rescore(db, actor, id, input, { registry, now: deps.clock() }),

    async progress(id: string): Promise<RunProgress> {
      const run = await requireRun(id);
      const budgetPause = run.status === 'paused' && run.pauseReason === 'budget';
      const [runModelRows, runTestRows, cells, running, activity, averageTotalMs, nextUsd, judgePending] = await Promise.all([
        repo.runModelsOf(id),
        repo.runTestsOf(id),
        repo.cellCounts(id),
        repo.runningOf(id),
        repo.recentActivity(id, ACTIVITY_LIMIT),
        repo.averageTotalMs(id),
        budgetPause ? nextCallMaxCostUsd(db, id) : null,
        countPendingJudgements(db, id),
      ]);
      return buildProgress({
        run,
        now: deps.clock(),
        models: runModelRows,
        runTests: runTestRows,
        cells,
        running,
        activity,
        averageTotalMs,
        nextCallMaxCostUsd: nextUsd,
        judgePending,
      });
    },

    /** Résultats d'une série ; pour un Utilisateur, réponses des tests manuels dont il n'a pas complété la question masquées. */
    async results(id: string, actor: Actor): Promise<ResultRow[]> {
      await requireRun(id);
      const [rows, hidden] = await Promise.all([
        repo.resultsOf(id),
        actor.role === 'admin' ? new Set<string>() : incompleteManualQuestions(db, actor.userId, id),
      ]);
      return rows.map(({ result: r, testName, category, modelName, color }) => ({
        id: r.id,
        runTestId: r.runTestId,
        testName,
        category,
        modelId: r.modelId,
        modelName,
        color,
        repetition: r.repetition,
        status: r.status,
        attempts: r.attempts,
        responseText: hidden.has(r.runTestId) ? null : r.responseText,
        finishReason: r.finishReason,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        reasoningTokens: r.reasoningTokens,
        tokensEstimated: r.tokensEstimated,
        ttftMs: r.ttftMs,
        totalMs: r.totalMs,
        tokensPerS: r.tokensPerS,
        costUsd: r.costUsd,
        costSource: r.costSource,
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
        scoreStatus: r.scoreStatus,
        completedAt: r.completedAt?.toISOString() ?? null,
        hiddenUntilScored: hidden.has(r.runTestId),
      }));
    },
  };
}

export type RunsService = ReturnType<typeof createRunsService>;
