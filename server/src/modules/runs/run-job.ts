import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { jobs } from '../../db/schema/jobs.js';
import { runs } from '../../db/schema/runs.js';
import { NotFoundError } from '../../errors.js';
import { describeError } from '../errors/capture.js';
import { reportError } from '../errors/report.js';
import { enqueue, type DbOrTx } from '../jobs/queue.js';

export const RUN_EXECUTE = 'run_execute';

// Conflit d'instantané (innodb_snapshot_isolation) et interblocage : la transaction courte est rejouée.
const RETRIABLE_ERRNOS = new Set([1020, 1213]);
const TX_ATTEMPTS = 3;

function errnoOf(err: unknown): number | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 4; depth++) {
    const { errno, cause } = e as { errno?: unknown; cause?: unknown };
    if (typeof errno === 'number') return errno;
    e = cause;
  }
  return undefined;
}

/** Rejoue une transaction courte sur conflit d'instantané (1020) ou interblocage (1213), trois essais au plus. */
export async function withTxRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const errno = errnoOf(err);
      if (attempt >= TX_ATTEMPTS || errno === undefined || !RETRIABLE_ERRNOS.has(errno)) throw err;
    }
  }
}

/**
 * Tâche d'exécution unique d'une série : sous verrou de la ligne `runs`, réutilise la tâche active (`queued` ou
 * `running`) désignée par `activeJobId`, sinon en enfile une nouvelle et l'enregistre. Sur une transaction en cours, le
 * travail se fait dans un point de sauvegarde de celle-ci (le verrou tient jusqu'à sa validation) ; sur la base, dans
 * une transaction propre.
 */
export async function enqueueRunJob(db: DbOrTx, runId: string, now: Date): Promise<string> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select({ activeJobId: runs.activeJobId }).from(runs).where(eq(runs.id, runId)).for('update');
    if (!run) throw new NotFoundError('Série introuvable');
    if (run.activeJobId !== null) {
      // Lecture courante : une lecture ordinaire dans une transaction englobante verrait un état figé plus ancien.
      const [job] = await tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, run.activeJobId)).for('update');
      if (job && (job.status === 'queued' || job.status === 'running')) return run.activeJobId;
    }
    const id = await enqueue(tx, { type: RUN_EXECUTE, payload: { runId } }, now);
    if (id === null) throw new Error('Tâche run_execute non créée'); // sans clé de déduplication : impossible
    await tx.update(runs).set({ activeJobId: id }).where(eq(runs.id, runId));
    return id;
  });
}

/**
 * Reprise des séries `queued` ou `running` sans tâche active (`activeJobId` nul, ou tâche `done`, `failed` ou absente) :
 * tâche `failed` (reprises épuisées) → série `interrupted`, à reprendre par l'Admin ; sinon une tâche est enfilée.
 * Chaque série est retraitée sous verrou de sa ligne : deux passages simultanés n'enfilent qu'une tâche. L'échec de la
 * reprise d'une série est journalisé (message masqué) sans arrêter celle des suivantes.
 */
export async function recoverRuns(db: Db, now: Date): Promise<{ enqueued: number; interrupted: number }> {
  const candidates = await db
    .select({ id: runs.id })
    .from(runs)
    .leftJoin(jobs, eq(jobs.id, runs.activeJobId))
    .where(
      and(
        inArray(runs.status, ['queued', 'running']),
        or(isNull(runs.activeJobId), isNull(jobs.id), inArray(jobs.status, ['done', 'failed'])),
      ),
    );
  let enqueued = 0;
  let interrupted = 0;
  for (const { id } of candidates) {
    let outcome: 'enqueued' | 'interrupted' | null;
    try {
      outcome = await recoverRun(db, id, now);
    } catch (err) {
      const d = describeError(err);
      await reportError(
        db,
        {
          source: 'job',
          origin: 'run_recovery',
          code: d.name,
          message: d.message,
          stack: d.stack,
          severity: 'normale',
          target: { type: 'run', id },
        },
        now,
      );
      continue;
    }
    if (outcome === 'enqueued') enqueued++;
    else if (outcome === 'interrupted') interrupted++;
  }
  return { enqueued, interrupted };
}

/** Reprise d'une série, sous verrou de sa ligne (voir `recoverRuns`). */
function recoverRun(db: Db, id: string, now: Date): Promise<'enqueued' | 'interrupted' | null> {
  return withTxRetry(() =>
    db.transaction(async (tx): Promise<'enqueued' | 'interrupted' | null> => {
      const [run] = await tx
        .select({ status: runs.status, activeJobId: runs.activeJobId })
        .from(runs)
        .where(eq(runs.id, id))
        .for('update');
      if (!run || (run.status !== 'queued' && run.status !== 'running')) return null;
      if (run.activeJobId !== null) {
        const [job] = await tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, run.activeJobId)).for('update');
        if (job && (job.status === 'queued' || job.status === 'running')) return null;
        if (job?.status === 'failed') {
          await tx
            .update(runs)
            .set({ status: 'interrupted', pauseReason: null, activeJobId: null })
            .where(eq(runs.id, id));
          return 'interrupted';
        }
      }
      await enqueueRunJob(tx, id, now);
      return 'enqueued';
    }),
  );
}

