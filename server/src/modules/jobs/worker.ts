import type { Db } from '../../db/client.js';
import type { Clock } from '../../lib/clock.js';
import { describeError, reportJobFailure } from '../errors/capture.js';
import { reportedReference } from '../errors/report.js';
import { InterruptedError, claimJob, completeJob, failJob, requeueInterrupted, updateProgress, type JobHandlers } from './queue.js';

/** Tâches d'envoi des notifications d'erreurs : leur échec est journalisé sans alerte. */
const NOTIFICATION_JOBS = new Set(['error_alert', 'error_digest']);

export type WorkerDeps = {
  db: Db;
  clock: Clock;
  workerId: string;
  jobTimeoutMs?: number;
  /** Arrêt du processus : annule la tâche en cours (combiné au délai de la tâche) et empêche d'en réserver une autre. */
  signal?: AbortSignal;
};

// Inférieur au délai de reprise des tâches abandonnées (15 min).
export const JOB_TIMEOUT_MS = 14 * 60_000;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** Réserve et exécute une tâche. Renvoie false s'il n'y avait rien à faire. Ne lève jamais à cause d'un handler. */
export async function runWorkerOnce(deps: WorkerDeps, handlers: JobHandlers): Promise<boolean> {
  const { db, clock, workerId } = deps;
  if (deps.signal?.aborted) return false;
  const job = await claimJob(db, workerId, clock());
  if (!job) return false;

  const handler = Object.hasOwn(handlers, job.type) ? handlers[job.type] : undefined;
  if (!handler) {
    await failJob(db, job, workerId, clock(), 'unknown_job_type', true);
    await reportJobFailure(
      db,
      job,
      { code: 'unknown_job_type', message: `Type de tâche inconnu : ${job.type}`, severity: 'grave' },
      clock(),
    );
    return true;
  }
  const controller = new AbortController();
  const timeoutMs = deps.jobTimeoutMs ?? JOB_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  try {
    const run = handler(job, {
      db,
      now: clock,
      signal: deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal,
      reportProgress: (progress) => updateProgress(db, job, workerId, clock(), progress),
    });
    run.catch(() => {}); // une exécution abandonnée après le délai ne doit pas produire de rejet non géré
    await Promise.race([run, timeout]);
  } catch (err) {
    if (err instanceof InterruptedError) await requeueInterrupted(db, job, workerId, clock());
    else {
      await failJob(db, job, workerId, clock(), messageOf(err));
      // Dernière tentative : grave ; sinon une reprise suivra. Une erreur déjà journalisée plus bas ne l'est pas deux fois.
      if (reportedReference(err) === null) {
        const d = describeError(err);
        await reportJobFailure(
          db,
          job,
          {
            code: d.name,
            message: d.message,
            stack: d.stack,
            severity: job.attempts >= job.maxAttempts ? 'grave' : 'normale',
            // L'échec d'une alerte ou d'un récapitulatif d'erreurs ne déclenche pas une alerte de plus (boucle).
            noAlert: NOTIFICATION_JOBS.has(job.type),
          },
          clock(),
        );
      }
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
  await completeJob(db, job, workerId, clock());
  return true;
}

/** Boucle d'interrogation : une tâche à la fois, la suivante n'est planifiée qu'une fois la précédente terminée. */
export function startWorker(
  deps: WorkerDeps,
  handlers: JobHandlers,
  opts: { intervalMs: number },
): { stop(): Promise<void>; status(): 'running' | 'stopped' } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    let again = false;
    try {
      again = await runWorkerOnce(deps, handlers);
    } catch (err) {
      console.error('worker : erreur inattendue', err);
    }
    if (!stopped) timer = setTimeout(run, again ? 0 : opts.intervalMs);
  };
  const run = (): void => {
    timer = undefined;
    current = tick();
  };
  timer = setTimeout(run, 0);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
    /** `stopped` dès que l'arrêt est demandé (la tâche en cours peut encore se terminer). */
    status: () => (stopped ? 'stopped' : 'running'),
  };
}
