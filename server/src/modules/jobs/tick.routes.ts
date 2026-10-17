import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../app.js';
import { UnauthorizedError } from '../../errors.js';
import { reportStaleJobs } from '../errors/capture.js';
import { flushPendingErrors } from '../errors/report.js';
import { recoverRuns } from '../runs/run-job.js';
import { recoverStaleJobs } from './queue.js';
import { scheduleDueJobs } from './scheduler.js';

export function secretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerTickRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/internal/tick', async (req) => {
    if (!secretMatches(req.headers['x-cron-secret'], deps.config.cronSecret)) throw new UnauthorizedError();
    const now = deps.clock();
    await flushPendingErrors(deps.db);
    const { requeued, failed, failedJobs } = await recoverStaleJobs(deps.db, now);
    await reportStaleJobs(deps.db, failedJobs, now);
    const runs = await recoverRuns(deps.db, now);
    const scheduled = await scheduleDueJobs(deps.db, deps.schedules, now);
    return { recovered: requeued, failedStale: failed, scheduled, runsEnqueued: runs.enqueued };
  });
}
