import { eq } from 'drizzle-orm';
import { jobs } from '../../db/schema/jobs.js';
import { runs } from '../../db/schema/runs.js';
import { NotFoundError } from '../../errors.js';
import { enqueue, type DbOrTx } from '../jobs/queue.js';

export const RUN_EXECUTE = 'run_execute';

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
