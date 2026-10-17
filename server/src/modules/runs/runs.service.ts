import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { models, providers } from '../../db/schema/catalog.js';
import type { RunWeights } from '../../db/schema/runs.js';
import { suiteTests, suites, testAttachments, tests } from '../../db/schema/tests.js';
import { ConflictError, NotFoundError, ValidationError } from '../../errors.js';
import type { Clock } from '../../lib/clock.js';
import { audit } from '../audit/audit.js';
import type { Actor } from '../auth/actor.js';
import type { DbOrTx } from '../jobs/queue.js';
import type { Registry } from '../providers/registry.js';
import type { PublicTest } from '../tests/tests.service.js';
import type { TestRow } from '../tests/tests.repo.js';
import { estimateRun, isSupported, type ModelForEstimate, type RunEstimate } from './estimate.js';
import { ACTIVITY_LIMIT, buildProgress, countsOf, type RunProgress, type StatusCounts } from './progress.js';
import { enqueueRunJob } from './run-job.js';
import { createRunsRepo, type ResultStatus, type RunRow } from './runs.repo.js';
import { snapshotOf, type TestSnapshot } from './snapshot.js';

export type Weights = RunWeights;

export const DEFAULT_WEIGHTS: Weights = { quality: 50, speed: 20, cost: 20, reliability: 10 };

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
};

export type RunsServiceDeps = {
  db: Db;
  clock: Clock;
  registry: Registry;
  config: Pick<AppConfig, 'dataDir'>;
};

type CandidateModel = Omit<ModelForEstimate, 'medianTotalMs'> & { available: boolean };

const runNotFound = () => new NotFoundError('Série introuvable');
const testNotFound = () => new ValidationError('test_not_found', 'Un des tests demandés est introuvable ou archivé');
const suiteNotFound = () => new ValidationError('suite_not_found', 'Suite introuvable');
const modelUnavailable = () =>
  new ConflictError('model_unavailable', 'Un des modèles demandés est indisponible (inactif, ou fournisseur sans clé utilisable)');
const judgeRequired = () => new ValidationError('judge_required', 'Un modèle juge est requis : la sélection contient des tests notés par le juge');

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

  async function candidateModels(conn: DbOrTx, ids: string[]): Promise<Map<string, CandidateModel>> {
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

  return {
    /** Estimation du coût maximal et de la durée, sans rien créer. */
    async estimate(input: RunInput): Promise<RunEstimate> {
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
     * combinaisons non supportées directement en `unsupported`), puis sa tâche `run_execute`.
     */
    async create(actor: Actor, input: RunInput): Promise<RunSummary> {
      const runId = randomUUID();
      const now = deps.clock();
      await db.transaction(async (tx) => {
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
        const resultRows = [];
        for (let repetition = 1; repetition <= input.repetitions; repetition++) {
          for (const rt of runTestRows) {
            for (const m of chosen) {
              const supported = isSupported(rt.snapshot, m);
              resultRows.push({
                id: randomUUID(),
                runId,
                runTestId: rt.id,
                modelId: m.id,
                repetition,
                status: supported ? ('pending' as const) : ('unsupported' as const),
                // Un résultat non supporté garde `pending` : la notation l'ignore.
                scoreStatus: supported && rt.snapshot.scoringMethod === 'manual' ? ('awaiting_manual' as const) : ('pending' as const),
              });
            }
          }
        }
        await repo.insertResults(tx, resultRows);
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
      });
      return (await summaries(runId))[0]!;
    },

    list: () => summaries(),

    async get(id: string): Promise<RunSummary> {
      const [summary] = await summaries(id);
      if (!summary) throw runNotFound();
      return summary;
    },

    async progress(id: string): Promise<RunProgress> {
      const run = await requireRun(id);
      const [runModelRows, runTestRows, cells, running, activity, averageTotalMs] = await Promise.all([
        repo.runModelsOf(id),
        repo.runTestsOf(id),
        repo.cellCounts(id),
        repo.runningOf(id),
        repo.recentActivity(id, ACTIVITY_LIMIT),
        repo.averageTotalMs(id),
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
      });
    },

    async results(id: string): Promise<ResultRow[]> {
      await requireRun(id);
      const rows = await repo.resultsOf(id);
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
        responseText: r.responseText,
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
      }));
    },
  };
}

export type RunsService = ReturnType<typeof createRunsService>;
