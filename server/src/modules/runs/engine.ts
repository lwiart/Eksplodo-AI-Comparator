// Moteur d'exécution des séries (tâche `run_execute`, spec §8.2) : une tranche de 10 minutes au plus, appels mesurés en
// parallèle (concurrence de la série et de chaque fournisseur), nouvelles tentatives, coût cumulé, puis tranche suivante.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { MySqlUpdateSetSource } from 'drizzle-orm/mysql-core';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { models, providers } from '../../db/schema/catalog.js';
import { results, runModels, runTests, runs } from '../../db/schema/runs.js';
import { AppError } from '../../errors.js';
import { describeError } from '../errors/capture.js';
import { redact, reportError } from '../errors/report.js';
import { InterruptedError, affectedRows, type Job, type JobContext } from '../jobs/queue.js';
import type { ProviderLike, Registry } from '../providers/registry.js';
import { readAttachment } from '../tests/attachments.js';
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

type WorkItem = {
  resultId: string;
  modelId: string;
  apiModelId: string;
  prices: ModelPrices;
  provider: ProviderLike;
  maxConcurrency: number;
  snapshot: TestSnapshot;
  attempts: number;
  /** Coût maximal estimé d'un appel, réservé sur le plafond tant que le résultat est en vol. */
  maxCostUsd: number;
};

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

/** Montant arrondi au micro-dollar (précision de `DECIMAL(12,6)`) : résultat, série et `ai_usage` concordent. */
export const roundUsd = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;

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
async function loadQueue(db: Db, runId: string): Promise<WorkItem[]> {
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
      return row;
    }),
  );
  if (!run) return;

  // 3. File de lancement de la tranche.
  const queue = await loadQueue(db, runId);
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
   */
  async function checkLaunch(item: WorkItem, reserved = false): Promise<'ok' | 'stopped' | 'over_budget'> {
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
      return 'stopped';
    }
    if (row.budgetUsd !== null) {
      const next = reserved ? 0 : item.maxCostUsd;
      if (roundUsd(row.modelsCostUsd + row.judgeCostUsd + inFlightUsd + next) > row.budgetUsd) return 'over_budget';
    }
    return 'ok';
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
  const backToPending = (item: WorkItem, giveBack: boolean) =>
    updateRunning(item.resultId, {
      status: 'pending',
      ...(giveBack ? { attempts: sql`GREATEST(${results.attempts} - 1, 0)` } : {}),
    });

  async function callOnce(item: WorkItem): Promise<CallOutcome> {
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

  async function finishDone(item: WorkItem, o: CallOutcome): Promise<void> {
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
    if (deps.onResultFinished) {
      await deps.onResultFinished(item.resultId).catch(async (err: unknown) => {
        // Journal des erreurs (message masqué par le journal) ; le résultat reste `done` et la tranche continue.
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
            target: { type: 'result', id: item.resultId },
          },
          ctx.now(),
        );
      });
    }
  }

  async function finishFailed(item: WorkItem, o: CallOutcome): Promise<void> {
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

  /** Appel puis nouvelles tentatives ; ne rejette jamais (une erreur inattendue arrête la tranche). */
  async function work(item: WorkItem): Promise<void> {
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

        // 5. Nouvelle tentative, si elle tient dans la tranche.
        const delay = retryDelayMs(outcome, item.attempts);
        if (nowMs() + delay >= deadline) return void (await backToPending(item, false));
        try {
          await sleep(delay, ctx.signal);
        } catch (err) {
          if (!ctx.signal.aborted) throw err;
          interrupted = true;
          await backToPending(item, false); // l'appel a eu lieu : la tentative reste comptée
          return;
        }
        if (expired()) return void (await backToPending(item, false));
        const check = await checkLaunch(item, true);
        if (check === 'stopped') return void (await backToPending(item, false));
        if (check === 'over_budget') {
          // Rendu à la file de la tranche : la boucle de lancement attend la fin d'autres appels, ou met la série en pause.
          if (await backToPending(item, false)) queue.unshift(item);
          return;
        }
        if (!(await updateRunning(item.resultId, { attempts: sql`${results.attempts} + 1`, startedAt: ctx.now() }))) return;
        item.attempts++;
      }
    } catch (err) {
      unexpected ??= err;
      stopLaunching = true;
    }
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
        const item = queue[index]!;
        const check = await checkLaunch(item);
        if (check === 'stopped') break;
        if (check === 'over_budget') {
          // Appels en vol : leur coût réel, souvent bien inférieur au coût maximal réservé, peut libérer de quoi lancer
          // celui-ci. Pause seulement quand l'appel ne tient pas alors qu'aucun appel n'est plus en vol.
          if (inFlight.size > 0) {
            await Promise.race(inFlight);
            continue;
          }
          stopLaunching = true;
          await pauseForBudget();
          break;
        }
        queue.splice(index, 1);
        // Réservation prise avant la prise du résultat, rendue à la fin de l'appel (coût alors compté dans la série).
        reservations.set(item.resultId, item.maxCostUsd);
        const claimed = await withTxRetry(async () =>
          affectedRows(
            await db
              .update(results)
              .set({ status: 'running', attempts: sql`${results.attempts} + 1`, startedAt: ctx.now() })
              .where(and(eq(results.id, item.resultId), eq(results.status, 'pending'))),
          ),
        );
        if (claimed !== 1) {
          reservations.delete(item.resultId);
          continue;
        }
        item.attempts++;
        const providerId = item.provider.id;
        perProvider.set(providerId, (perProvider.get(providerId) ?? 0) + 1);
        const task: Promise<void> = work(item).finally(() => {
          reservations.delete(item.resultId);
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
      const [left] = await tx
        .select({ n: sql<number>`COUNT(*)` })
        .from(results)
        .where(and(eq(results.runId, runId), inArray(results.status, ['pending', 'running'])));
      if (Number(left?.n ?? 0) > 0) {
        await tx.update(runs).set({ activeJobId: null }).where(eq(runs.id, runId));
        await enqueueRunJob(tx, runId, ctx.now());
      } else {
        await tx.update(runs).set({ status: 'completed', completedAt: ctx.now(), activeJobId: null }).where(eq(runs.id, runId));
      }
    }),
  );
}
