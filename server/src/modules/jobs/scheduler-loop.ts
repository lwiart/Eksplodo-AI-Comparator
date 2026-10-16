import type { Db } from '../../db/client.js';
import type { Clock } from '../../lib/clock.js';
import { reportStaleJobs } from '../errors/capture.js';
import { flushPendingErrors } from '../errors/report.js';
import { recoverStaleJobs } from './queue.js';
import { scheduleDueJobs, validateScheduleEntry, type ScheduleEntry } from './scheduler.js';

type LogFn = (obj: object, msg: string) => void;

/**
 * Planificateur interne : un passage immédiat puis toutes les `intervalMs` (60 s en production) : reprise des
 * tâches abandonnées puis création des tâches planifiées échues (idempotent grâce aux clés de dédoublonnage ;
 * le cron `/internal/tick` fait de même et réveille l'application). Les entrées sont validées au démarrage :
 * une entrée invalide lève immédiatement.
 */
export function startSchedulerLoop(
  deps: { db: Db; schedules: ScheduleEntry[]; clock: Clock; logger: { info: LogFn; error: LogFn } },
  opts: { intervalMs: number },
): { stop(): Promise<void> } {
  deps.schedules.forEach(validateScheduleEntry);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    try {
      const now = deps.clock();
      await flushPendingErrors(deps.db);
      const { requeued, failed, failedJobs } = await recoverStaleJobs(deps.db, now);
      await reportStaleJobs(deps.db, failedJobs, now);
      const scheduled = await scheduleDueJobs(deps.db, deps.schedules, now);
      if (requeued + failed + scheduled > 0) deps.logger.info({ requeued, failed, scheduled }, 'planificateur');
    } catch (err) {
      deps.logger.error({ err }, 'planificateur : passage en échec');
    }
    if (!stopped) timer = setTimeout(run, opts.intervalMs);
  };
  const run = (): void => {
    timer = undefined;
    current = tick();
  };
  run();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}
