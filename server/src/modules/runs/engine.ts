// Moteur d'exécution des séries (tâche `run_execute`, spec §8.2) : une tranche de 10 minutes au plus, appels mesurés en
// parallèle (concurrence de la série et de chaque fournisseur), nouvelles tentatives, coût cumulé, notes du juge (mêmes
// concurrence et plafond), puis tranche suivante.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { MySqlUpdateSetSource } from 'drizzle-orm/mysql-core';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { models, providers } from '../../db/schema/catalog.js';
import { results, runModels, runTests, runs } from '../../db/schema/runs.js';
import { AppError } from '../../errors.js';
import { roundUsd } from '../../lib/money.js';
import { describeError } from '../errors/capture.js';
import { redact, reportError } from '../errors/report.js';
import { InterruptedError, affectedRows, type Job, type JobContext } from '../jobs/queue.js';
import type { ProviderLike, Registry } from '../providers/registry.js';
import { readAttachment } from '../tests/attachments.js';
import {
  MAX_INVALID_REPLIES,
  UNREADABLE_REPLY,
  claimJudgement,
  commitJudgeCall,
  countPendingJudgements,
  currentJudgeId,
  failJudgements,
  holdsJudgement,
  judgeCallMaxCostUsd,
  judgeInputTokens,
  loadPendingJudgements,
  loadRunJudge,
  measureJudgeCall,
  readJudgeAttachments,
  readResponse,
  releaseJudgement,
  resetJudgeClaims,
  type JudgeModel,
  type JudgeVerdict,
  type PendingJudgement,
} from '../scoring/judge-items.js';
import { pendingExpectedScores } from '../scoring/expected.js';
import { parseJudgeReply } from '../scoring/judge-parse.js';
import { recordUsage } from '../usage/usage.js';
import { buildRequest, measureCall, type CallOutcome, type ModelPrices } from './call.js';
import { estimateInputTokens, maxCallCostUsd } from './estimate.js';
import { RUN_EXECUTE, enqueueRunJob, withTxRetry } from './run-job.js';
import type { TestSnapshot } from './snapshot.js';

/** Durée d'une tranche : ni lancement ni nouvelle tentative au-delà (les appels en cours se terminent, ≤ 120 s). */
export const SLICE_MS = 600_000;
/** Nouvelles tentatives au plus par résultat (soit trois appels). */
export const MAX_RETRIES = 2;
export const RETRY_DELAYS_MS = [2_000, 8_000] as const;
export const RETRY_AFTER_MAX_MS = 30_000;
/** Signe de vie de la file : avancement enregistré au moins à cet intervalle. */
export const PROGRESS_INTERVAL_MS = 60_000;

export type EngineDeps = {
  db: Db;
  registry: Pick<Registry, 'adapterFor'>;
  config: Pick<AppConfig, 'dataDir'>;
  /** Attente annulable entre deux tentatives (injectée par les tests). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  sliceMs?: number;
  /** Appelé après la validation de chaque résultat `done` (notation, plan 4). */
  onResultFinished?: (resultId: string) => Promise<void>;
};

type BaseItem = {
  /** Clé de l'élément et de sa réservation (un résultat peut être généré puis noté dans la même tranche). */
  key: string;
  resultId: string;
  /** Fournisseur appelé : celui du modèle évalué, ou celui du juge (son plafond de concurrence s'applique). */
  provider: ProviderLike;
  maxConcurrency: number;
  snapshot: TestSnapshot;
  /** Coût maximal estimé d'un appel, réservé sur le plafond tant que l'élément est en vol. */
  maxCostUsd: number;
};

/** Appel de génération d'un résultat `pending`. */
type GenerateItem = BaseItem & {
  kind: 'generate';
  modelId: string;
  apiModelId: string;
  prices: ModelPrices;
  attempts: number;
};

/** Note du juge d'un résultat `done` ; compteurs gardés en mémoire le temps de la tranche. */
type JudgeItem = BaseItem & {
  kind: 'judge';
  judge: JudgeModel;
  responseChars: number;
  inputTokens: number;
  /** Nouvelles tentatives après une erreur réessayable. */
  retries: number;
  /** Réponses illisibles déjà reçues. */
  invalidReplies: number;
};

type WorkItem = GenerateItem | JudgeItem;

/** Contrôle avant un lancement ; `inFlightUsd` : réservations comptées, `fits` : un appel de ce coût maximal tiendrait. */
type LaunchCheck = { verdict: 'ok' | 'stopped' | 'over_budget'; inFlightUsd: number; fits(costUsd: number): boolean };

const FINISHED_STATUSES = ['done', 'error', 'timeout', 'unsupported'] as const;

/** Attente annulable : rejette avec la raison du signal. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Échec survenu avant l'appel (clé, pièce jointe…) : définitif. */
function failedBeforeCall(code: string, message: string): CallOutcome {
  return {
    status: 'error',
    text: '',
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: null,
    tokensEstimated: true,
    ttftMs: null,
    totalMs: 0,
    tokensPerS: null,
    costUsd: null,
    costSource: null,
    errorCode: code,
    errorMessage: redact(message),
    retryable: false,
    retryAfterMs: null,
  };
}

function attachmentErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  return err instanceof Error ? err.name : 'Error';
}

/** Délai avant la prochaine tentative : `Retry-After` (plafonné à 30 s), sinon 2 s puis 8 s. */
function retryDelayMs(outcome: CallOutcome, attempts: number): number {
  if (outcome.retryAfterMs !== null) return Math.min(Math.max(0, outcome.retryAfterMs), RETRY_AFTER_MAX_MS);
  return RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1]!;
}

function runIdOf(job: Job): string {
  const runId = (job.payload as { runId?: unknown } | null)?.runId;
  if (typeof runId !== 'string') throw new Error('Tâche run_execute sans runId');
  return runId;
}

/** Résultats en attente : par répétition, position du test, puis modèles en alternance (ordre d'ajout à la série). */
async function loadQueue(db: Db, runId: string): Promise<GenerateItem[]> {
  const [pending, snapshots, modelRows] = await Promise.all([
    db
      .select({ id: results.id, runTestId: results.runTestId, modelId: results.modelId, attempts: results.attempts })
      .from(results)
      .innerJoin(runTests, eq(runTests.id, results.runTestId))
      .innerJoin(runModels, and(eq(runModels.runId, results.runId), eq(runModels.modelId, results.modelId)))
      .innerJoin(models, eq(models.id, results.modelId))
      .where(and(eq(results.runId, runId), eq(results.status, 'pending')))
      .orderBy(asc(results.repetition), asc(runTests.position), asc(runModels.addedAt), asc(models.displayName), asc(models.id)),
    db.select({ id: runTests.id, snapshot: runTests.snapshot }).from(runTests).where(eq(runTests.runId, runId)),
    db
      .select({ model: models, provider: providers })
      .from(runModels)
      .innerJoin(models, eq(models.id, runModels.modelId))
      .innerJoin(providers, eq(providers.id, models.providerId))
      .where(eq(runModels.runId, runId)),
  ]);
  const snapshotOf = new Map(snapshots.map((s) => [s.id, s.snapshot]));
  const modelOf = new Map(modelRows.map((r) => [r.model.id, r]));
  return pending.map((r) => {
    const { model, provider } = modelOf.get(r.modelId)!;
    const prices = { inputPricePerM: model.inputPricePerM, outputPricePerM: model.outputPricePerM };
    const snapshot = snapshotOf.get(r.runTestId)!;
    return {
      kind: 'generate' as const,
      key: `generate:${r.id}`,
      resultId: r.id,
      modelId: r.modelId,
      apiModelId: model.apiModelId,
      prices,
      provider,
      maxConcurrency: Math.max(1, provider.maxConcurrency),
      snapshot,
      attempts: r.attempts,
      maxCostUsd: maxCallCostUsd(snapshot, prices),
    };
  });
}

/** Tranche d'exécution d'une série ; seule la tâche désignée par `runs.activeJobId` y travaille. */
export async function executeRunSlice(deps: EngineDeps, job: Job, ctx: JobContext): Promise<void> {
  const { db } = deps;
  const runId = runIdOf(job);
  const sleep = deps.sleep ?? abortableSleep;
  const nowMs = () => ctx.now().getTime();
  const deadline = nowMs() + (deps.sliceMs ?? SLICE_MS);
  const expired = () => nowMs() >= deadline;

  // 1-2. Tâche active et série à exécuter : passage `running`, résultats orphelins remis en attente (tentative rendue).
  const run = await withTxRetry(() =>
    db.transaction(async (tx) => {
      const [row] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update');
      if (!row || row.activeJobId !== job.id || (row.status !== 'queued' && row.status !== 'running')) return null;
      await tx
        .update(runs)
        .set({ status: 'running', startedAt: row.startedAt ?? ctx.now() })
        .where(eq(runs.id, runId));
      await tx
        .update(results)
        .set({ status: 'pending', attempts: sql`GREATEST(${results.attempts} - 1, 0)` })
        .where(and(eq(results.runId, runId), eq(results.status, 'running')));
      await resetJudgeClaims(tx, runId);
      return row;
    }),
  );
  if (!run) return;

  /** Crochet de notation d'un résultat terminé ; une erreur est journalisée, le résultat reste `done` et la tranche continue. */
  async function notifyFinished(resultId: string): Promise<void> {
    if (!deps.onResultFinished) return;
    await deps.onResultFinished(resultId).catch(async (err: unknown) => {
      // Journal des erreurs (message masqué par le journal).
      const d = describeError(err);
      await reportError(
        db,
        {
          source: 'job',
          origin: RUN_EXECUTE,
          code: d.name,
          message: d.message,
          stack: d.stack,
          severity: 'normale',
          target: { type: 'result', id: resultId },
        },
        ctx.now(),
      );
    });
  }

  // Notes par réponse attendue restées en attente après la fin de leur résultat (arrêt du processus, erreur) : reprises
  // avant tout lancement. Aucun verrou n'est tenu ici : chaque note est une écriture conditionnée d'une seule ligne.
  if (deps.onResultFinished) {
    for (const resultId of await pendingExpectedScores(db, runId)) await notifyFinished(resultId);
  }

  // 3. File de lancement de la tranche : appels de génération, puis notes du juge en attente.
  const queue: WorkItem[] = await loadQueue(db, runId);
  let cachedJudgeId = run.judgeModelId;
  let cachedJudge = await loadRunJudge(db, cachedJudgeId);

  /**
   * Juge actuel de la série, relu à chaque décision et rechargé s'il a changé (recalcul avec un autre juge pendant la
   * tranche). Les valeurs renvoyées font foi ; le cache ne sert qu'à éviter de recharger un juge inchangé.
   */
  async function currentJudge() {
    const id = await currentJudgeId(db, runId);
    if (id === cachedJudgeId) return { id, state: cachedJudge };
    const state = await loadRunJudge(db, id);
    cachedJudgeId = id;
    cachedJudge = state;
    return { id, state };
  }

  /**
   * Notes du juge ajoutées en fin de file, avec le juge actuel de la série ; juge indisponible : mises en échec aussitôt
   * (aucune tranche sans fin), seulement si le juge de la série est toujours celui-là.
   */
  async function addJudgements(pending: PendingJudgement[]): Promise<void> {
    if (pending.length === 0) return;
    const { id, state } = await currentJudge();
    const { judge } = state;
    if (judge === null) {
      return failJudgements(db, {
        runId,
        resultIds: pending.map((p) => p.resultId),
        rationale: state.unavailable,
        expectedJudgeId: id,
      });
    }
    for (const p of pending) {
      const inputTokens = judgeInputTokens(p.snapshot, p.responseChars, judge);
      queue.push({
        kind: 'judge',
        key: `judge:${p.resultId}`,
        resultId: p.resultId,
        provider: judge.provider,
        maxConcurrency: Math.max(1, judge.provider.maxConcurrency),
        snapshot: p.snapshot,
        maxCostUsd: judgeCallMaxCostUsd(inputTokens, judge.prices),
        judge,
        responseChars: p.responseChars,
        inputTokens,
        retries: 0,
        invalidReplies: 0,
      });
    }
  }
  await addJudgements(await loadPendingJudgements(db, runId));
  const counts = await db
    .select({ status: results.status, n: sql<number>`COUNT(*)` })
    .from(results)
    .where(eq(results.runId, runId))
    .groupBy(results.status);
  const total = counts.reduce((s, c) => s + Number(c.n), 0);
  let finished = counts
    .filter((c) => (FINISHED_STATUSES as readonly string[]).includes(c.status))
    .reduce((s, c) => s + Number(c.n), 0);

  const report = () =>
    ctx.reportProgress({ done: finished, total }).catch((err: unknown) => {
      console.warn('run_execute : avancement non enregistré', { runId, err: err instanceof Error ? err.message : String(err) });
    });
  await report();
  const progressTimer = setInterval(() => void report(), PROGRESS_INTERVAL_MS);
  progressTimer.unref();

  const concurrency = Math.max(1, run.concurrency);
  const perProvider = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();
  /** Réservations sur le plafond : coût maximal des appels lancés et non terminés, par résultat. */
  const reservations = new Map<string, number>();
  let stopLaunching = false;
  let interrupted = false;
  let unexpected: unknown = null;

  /** Pause pour plafond atteint, sous verrou, seulement si la série tourne encore sous cette tâche. */
  async function pauseForBudget(): Promise<void> {
    await withTxRetry(() =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .select({ status: runs.status, activeJobId: runs.activeJobId })
          .from(runs)
          .where(eq(runs.id, runId))
          .for('update');
        if (row?.status !== 'running' || row.activeJobId !== job.id) return;
        await tx.update(runs).set({ status: 'paused', pauseReason: 'budget' }).where(eq(runs.id, runId));
      }),
    );
  }

  /**
   * Avant chaque lancement (nouvelle tentative comprise) : relit la série (pause, tâche remplacée, plafond éventuellement
   * relevé), puis vérifie que dépense + réservations en vol + coût maximal de l'appel ne dépassent pas le plafond. Une
   * nouvelle tentative garde la réservation de son résultat (`reserved`) : seul un nouvel appel en ajoute une.
   * `stopped` : plus aucun lancement (série arrêtée ou tâche remplacée) ; `over_budget` : l'appel ne tient pas pour l'instant.
   * `fits` dit si un appel d'un autre coût maximal tiendrait, d'après la même lecture.
   */
  async function checkLaunch(item: WorkItem, reserved = false): Promise<LaunchCheck> {
    // Réservations additionnées avant la lecture : un appel qui se termine pendant celle-ci est alors compté deux fois
    // (réservation et dépense) plutôt qu'oublié (dépense lue avant sa validation, réservation déjà rendue).
    const inFlightUsd = [...reservations.values()].reduce((s, usd) => s + usd, 0);
    const [row] = await db
      .select({
        status: runs.status,
        activeJobId: runs.activeJobId,
        budgetUsd: runs.budgetUsd,
        modelsCostUsd: runs.modelsCostUsd,
        judgeCostUsd: runs.judgeCostUsd,
      })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!row || row.status !== 'running' || row.activeJobId !== job.id) {
      stopLaunching = true;
      return { verdict: 'stopped', inFlightUsd, fits: () => false };
    }
    const fits = (costUsd: number) =>
      row.budgetUsd === null || roundUsd(row.modelsCostUsd + row.judgeCostUsd + inFlightUsd + costUsd) <= row.budgetUsd;
    return { verdict: fits(reserved ? 0 : item.maxCostUsd) ? 'ok' : 'over_budget', inFlightUsd, fits };
  }

  /** Écriture conditionnée au statut `running` du résultat ; renvoie vrai si la ligne a changé. */
  const updateRunning = (resultId: string, values: MySqlUpdateSetSource<typeof results>) =>
    withTxRetry(async () =>
      affectedRows(
        await db
          .update(results)
          .set(values)
          .where(and(eq(results.id, resultId), eq(results.status, 'running'))),
      ) === 1,
    );

  /** Remet le résultat en attente : tentative gardée (tranche échue, pause) ou rendue (arrêt du processus). */
  const backToPending = (item: GenerateItem, giveBack: boolean) =>
    updateRunning(item.resultId, {
      status: 'pending',
      ...(giveBack ? { attempts: sql`GREATEST(${results.attempts} - 1, 0)` } : {}),
    });

  async function callOnce(item: GenerateItem): Promise<CallOutcome> {
    let adapter;
    try {
      adapter = deps.registry.adapterFor(item.provider);
    } catch (err) {
      if (err instanceof AppError) return failedBeforeCall(err.code, err.message);
      throw err;
    }
    let req;
    try {
      req = await buildRequest(item.snapshot, item.apiModelId, (a) => readAttachment(deps.config, a));
    } catch (err) {
      // Cause journalisée sans chemin ni contenu : nom ou code système seulement (ENOENT, EACCES…).
      const code = attachmentErrorCode(err);
      console.warn('run_execute : pièce jointe illisible', { resultId: item.resultId, code });
      return failedBeforeCall('attachment_unreadable', `Pièce jointe illisible (${code}) : le fichier n'a pas pu être lu`);
    }
    return measureCall(adapter, req, item.prices, {
      now: nowMs,
      signal: ctx.signal,
      estimatedInputTokens: estimateInputTokens(item.snapshot), // 800 tokens par page de PDF
    });
  }

  async function finishDone(item: GenerateItem, o: CallOutcome): Promise<void> {
    const costUsd = roundUsd(o.costUsd ?? 0);
    const committed = await withTxRetry(() =>
      db.transaction(async (tx) => {
        const res = await tx
          .update(results)
          .set({
            status: 'done',
            responseText: o.text,
            finishReason: o.finishReason,
            inputTokens: o.inputTokens,
            outputTokens: o.outputTokens,
            reasoningTokens: o.reasoningTokens,
            tokensEstimated: o.tokensEstimated,
            ttftMs: o.ttftMs,
            totalMs: o.totalMs,
            tokensPerS: o.tokensPerS,
            costUsd,
            costSource: o.costSource,
            errorCode: null,
            errorMessage: null,
            completedAt: ctx.now(),
          })
          .where(and(eq(results.id, item.resultId), eq(results.status, 'running')));
        if (affectedRows(res) !== 1) return false;
        await tx
          .update(runs)
          .set({ modelsCostUsd: sql`${runs.modelsCostUsd} + ${costUsd}` })
          .where(eq(runs.id, runId));
        await recordUsage(tx, {
          origin: 'run',
          runId,
          modelId: item.modelId,
          inputTokens: o.inputTokens,
          outputTokens: o.outputTokens,
          reasoningTokens: o.reasoningTokens ?? 0,
          costUsd,
          now: ctx.now(),
        });
        return true;
      }),
    );
    if (!committed) return;
    finished++;
    // Test noté par le juge : sa note rejoint la file de la tranche (même concurrence, même plafond).
    if (item.snapshot.scoringMethod === 'judge') {
      await addJudgements([{ resultId: item.resultId, snapshot: item.snapshot, responseChars: o.text.length }]);
    }
    await notifyFinished(item.resultId);
  }

  async function finishFailed(item: GenerateItem, o: CallOutcome): Promise<void> {
    const changed = await updateRunning(item.resultId, {
      status: o.status,
      responseText: o.text === '' ? null : o.text,
      finishReason: o.finishReason,
      inputTokens: o.inputTokens,
      outputTokens: o.outputTokens,
      reasoningTokens: o.reasoningTokens,
      tokensEstimated: o.tokensEstimated,
      ttftMs: o.ttftMs,
      totalMs: o.totalMs,
      tokensPerS: null,
      costUsd: null,
      costSource: null,
      errorCode: o.errorCode,
      errorMessage: o.errorMessage,
      completedAt: ctx.now(),
    });
    if (changed) finished++;
  }

  /**
   * 5. Avant un nouvel appel du même élément (nouvelle tentative, ou nouvel appel du juge après une réponse illisible) :
   * attente éventuelle, puis mêmes contrôles qu'un lancement. `later` : la tranche est échue, ou le serait pendant
   * l'attente ; `interrupted` : arrêt du processus pendant l'attente ; `over_budget` : élément à rendre à la file de la
   * tranche (la boucle de lancement attend la fin d'autres appels, ou met la série en pause).
   */
  async function beforeNextCall(item: WorkItem, delay: number): Promise<'go' | 'later' | 'stopped' | 'over_budget' | 'interrupted'> {
    if (delay > 0) {
      if (nowMs() + delay >= deadline) return 'later';
      try {
        await sleep(delay, ctx.signal);
      } catch (err) {
        if (!ctx.signal.aborted) throw err;
        interrupted = true;
        return 'interrupted';
      }
    }
    if (expired()) return 'later';
    const { verdict } = await checkLaunch(item, true);
    return verdict === 'ok' ? 'go' : verdict;
  }

  /** Appel puis nouvelles tentatives ; ne rejette jamais (une erreur inattendue arrête la tranche). */
  async function work(item: GenerateItem): Promise<void> {
    try {
      for (;;) {
        let outcome: CallOutcome;
        try {
          outcome = await callOnce(item);
        } catch (err) {
          if (!ctx.signal.aborted) throw err;
          interrupted = true;
          await backToPending(item, true);
          return;
        }
        if (outcome.status === 'done') return await finishDone(item, outcome);
        if (!outcome.retryable || item.attempts > MAX_RETRIES) return await finishFailed(item, outcome);

        const next = await beforeNextCall(item, retryDelayMs(outcome, item.attempts));
        if (next === 'over_budget') {
          if (await backToPending(item, false)) queue.unshift(item);
          return;
        }
        // L'appel a eu lieu : la tentative reste comptée.
        if (next !== 'go') return void (await backToPending(item, false));
        if (!(await updateRunning(item.resultId, { attempts: sql`${results.attempts} + 1`, startedAt: ctx.now() }))) return;
        item.attempts++;
      }
    } catch (err) {
      unexpected ??= err;
      stopLaunching = true;
    }
  }

  const judgementOf = (item: JudgeItem) => ({ runId, resultId: item.resultId, judgeModelId: item.judge.id, jobId: job.id });
  const pendingOf = (item: JudgeItem): PendingJudgement => ({
    resultId: item.resultId,
    snapshot: item.snapshot,
    responseChars: item.responseChars,
  });

  async function callJudge(item: JudgeItem): Promise<CallOutcome> {
    let adapter;
    try {
      adapter = deps.registry.adapterFor(item.provider);
    } catch (err) {
      if (err instanceof AppError) return failedBeforeCall(err.code, err.message);
      throw err;
    }
    let attachments;
    try {
      attachments = await readJudgeAttachments(item.snapshot, item.judge, (a) => readAttachment(deps.config, a));
    } catch (err) {
      const code = attachmentErrorCode(err);
      console.warn('run_execute : pièce jointe illisible (juge)', { resultId: item.resultId, code });
      return failedBeforeCall('attachment_unreadable', `Pièce jointe illisible (${code}) : le fichier n'a pas pu être lu`);
    }
    return measureJudgeCall(
      adapter,
      { snapshot: item.snapshot, response: await readResponse(db, item.resultId), judge: item.judge, attachments, inputTokens: item.inputTokens },
      { now: nowMs, signal: ctx.signal },
    );
  }

  /** Appel du juge écrit : coût s'il est facturé (réponse reçue), puis la note ou l'échec (`null` : un appel suit). */
  const commitJudge = (item: JudgeItem, o: CallOutcome, verdict: JudgeVerdict | null) =>
    commitJudgeCall(db, {
      runId,
      resultId: item.resultId,
      jobId: job.id,
      judgeModelId: item.judge.id,
      billed:
        o.status === 'done'
          ? {
              costUsd: roundUsd(o.costUsd ?? 0),
              inputTokens: o.inputTokens,
              outputTokens: o.outputTokens,
              reasoningTokens: o.reasoningTokens ?? 0,
            }
          : null,
      verdict,
      now: ctx.now(),
    });

  /**
   * Note du juge : appel, lecture stricte de la réponse (illisible → un seul nouvel appel, facturé lui aussi), nouvelles
   * tentatives sur erreur réessayable comme la génération ; ne rejette jamais (une erreur inattendue arrête la tranche).
   */
  async function judgeWork(item: JudgeItem): Promise<void> {
    try {
      for (;;) {
        let outcome: CallOutcome;
        try {
          outcome = await callJudge(item);
        } catch (err) {
          if (!ctx.signal.aborted) throw err;
          interrupted = true;
          await releaseJudgement(db, item.resultId, job.id);
          return;
        }
        let delay = 0;
        if (outcome.status === 'done') {
          const reply = parseJudgeReply(outcome.text);
          if (reply.ok) return await commitJudge(item, outcome, { score: reply.score, rationale: reply.rationale });
          if (item.invalidReplies >= MAX_INVALID_REPLIES) return await commitJudge(item, outcome, { failed: UNREADABLE_REPLY });
          item.invalidReplies++;
          await commitJudge(item, outcome, null);
        } else {
          if (!outcome.retryable || item.retries >= MAX_RETRIES) {
            return await commitJudge(item, outcome, { failed: `Juge indisponible : ${outcome.errorMessage ?? outcome.errorCode}` });
          }
          item.retries++;
          delay = retryDelayMs(outcome, item.retries);
        }
        const next = await beforeNextCall(item, delay);
        if (next === 'go') {
          // Un recalcul a pu retirer la prise ou changer le juge pendant l'appel : aucun nouvel appel facturé pour rien.
          const hold = await holdsJudgement(db, judgementOf(item));
          if (hold === 'held') continue;
          if (hold === 'stale' && (await releaseJudgement(db, item.resultId, job.id))) await addJudgements([pendingOf(item)]);
          return;
        }
        // Note rendue, toujours en attente : relancée par la boucle de lancement (plafond) ou par la tranche suivante.
        if ((await releaseJudgement(db, item.resultId, job.id)) && next === 'over_budget') queue.unshift(item);
        return;
      }
    } catch (err) {
      unexpected ??= err;
      stopLaunching = true;
    }
  }

  /** Prise de l'élément avant son lancement : résultat `pending` → `running`, ou note du juge prise par cette tâche. */
  async function claim(item: WorkItem): Promise<boolean> {
    if (item.kind === 'judge') {
      const claimed = await claimJudgement(db, judgementOf(item));
      // Juge changé par un recalcul : la note est reprise en fin de file avec le nouveau juge.
      if (claimed === 'stale') await addJudgements([pendingOf(item)]);
      return claimed === 'claimed';
    }
    const claimed = await withTxRetry(async () =>
      affectedRows(
        await db
          .update(results)
          .set({ status: 'running', attempts: sql`${results.attempts} + 1`, startedAt: ctx.now() })
          .where(and(eq(results.id, item.resultId), eq(results.status, 'pending'))),
      ),
    );
    if (claimed !== 1) return false;
    item.attempts++;
    return true;
  }

  try {
    // 4. Lancements dans la limite de la série et de chaque fournisseur. Une erreur ici (lecture du statut, prise d'un
    // résultat) arrête les lancements sans abandonner les appels en cours : ils se terminent avant qu'elle soit relevée.
    try {
      while (!stopLaunching && !ctx.signal.aborted && !expired()) {
        const index =
          inFlight.size < concurrency ? queue.findIndex((it) => (perProvider.get(it.provider.id) ?? 0) < it.maxConcurrency) : -1;
        if (index === -1) {
          if (inFlight.size === 0) break; // file vide
          await Promise.race(inFlight);
          continue;
        }
        let item = queue[index]!;
        const check = await checkLaunch(item);
        if (check.verdict === 'stopped') break;
        if (check.verdict === 'over_budget') {
          // Appels en vol : leur coût réel, souvent bien inférieur au coût maximal réservé, peut libérer de quoi lancer
          // celui-ci. Un appel terminé pendant la lecture (réservation comptée avec sa dépense) : nouveau contrôle.
          if (inFlight.size > 0) {
            await Promise.race(inFlight);
            continue;
          }
          if (check.inFlightUsd > 0) continue;
          // Plus rien en vol : premier appel de la file qui tient encore (même règle que la reprise), sinon pause.
          const cheaper = queue.find((it) => check.fits(it.maxCostUsd));
          if (!cheaper) {
            stopLaunching = true;
            await pauseForBudget();
            break;
          }
          item = cheaper;
        }
        // La file a pu changer pendant le contrôle (nouvelle tentative rendue en tête) : l'appel est retrouvé par identité.
        const at = queue.indexOf(item);
        if (at === -1) continue;
        queue.splice(at, 1);
        // Réservation prise avant la prise de l'élément, rendue à la fin de l'appel (coût alors compté dans la série).
        const { key } = item;
        reservations.set(key, item.maxCostUsd);
        if (!(await claim(item))) {
          reservations.delete(key);
          continue;
        }
        const providerId = item.provider.id;
        perProvider.set(providerId, (perProvider.get(providerId) ?? 0) + 1);
        const task: Promise<void> = (item.kind === 'generate' ? work(item) : judgeWork(item)).finally(() => {
          reservations.delete(key);
          perProvider.set(providerId, perProvider.get(providerId)! - 1);
          inFlight.delete(task);
        });
        inFlight.add(task);
      }
    } catch (err) {
      unexpected ??= err;
      stopLaunching = true;
    }
    // 6. Plus de lancement : les appels en cours se terminent.
    await Promise.all(inFlight);
  } finally {
    clearInterval(progressTimer);
  }

  if (unexpected !== null) throw unexpected;
  if (interrupted || ctx.signal.aborted) throw new InterruptedError();
  await report();

  // 7. Tranche suivante, fin de la série, ou retrait de la tâche (pause) — sous verrou, et seulement pour la tâche active.
  await withTxRetry(() =>
    db.transaction(async (tx) => {
      const [row] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update');
      if (!row || row.activeJobId !== job.id) return;
      if (row.status !== 'running' && row.status !== 'queued') {
        await tx.update(runs).set({ activeJobId: null }).where(eq(runs.id, runId));
        return;
      }
      // Fin seulement sans résultat à exécuter ni note du juge en attente (les notes manuelles n'empêchent pas la fin).
      const [left] = await tx
        .select({ n: sql<number>`COUNT(*)` })
        .from(results)
        .where(and(eq(results.runId, runId), inArray(results.status, ['pending', 'running'])));
      if (Number(left?.n ?? 0) + (await countPendingJudgements(tx, runId)) > 0) {
        await tx.update(runs).set({ activeJobId: null }).where(eq(runs.id, runId));
        await enqueueRunJob(tx, runId, ctx.now());
      } else {
        await tx.update(runs).set({ status: 'completed', completedAt: ctx.now(), activeJobId: null }).where(eq(runs.id, runId));
      }
    }),
  );
}
