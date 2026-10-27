import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { jobs } from '../../db/schema/jobs.js';
import type { Clock } from '../../lib/clock.js';
import { isDuplicateEntry } from '../../lib/db-errors.js';

export type Job = typeof jobs.$inferSelect;
/** Base ou transaction en cours (création d'une tâche dans la même transaction que la donnée qui la motive). */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
export type JobInput = {
  type: string;
  payload?: unknown;
  runAt?: Date;
  maxAttempts?: number;
  dedupeKey?: string;
};
/**
 * Les gestionnaires doivent être idempotents (une tâche peut être rejouée après une reprise ou un délai dépassé).
 * Pour un travail long, appeler `reportProgress` au moins toutes les 15 minutes (signe de vie) ;
 * le délai maximal d'exécution (14 min) s'applique quoi qu'il arrive, et `signal` est annulé à l'échéance.
 */
export type JobContext = {
  db: Db;
  now: Clock;
  signal: AbortSignal;
  reportProgress(progress: Record<string, unknown>): Promise<void>;
};
export type JobHandler = (job: Job, ctx: JobContext) => Promise<void>;
export type JobHandlers = Record<string, JobHandler>;

/**
 * Arrêt demandé (`ctx.signal` : arrêt du processus) ou exécution impossible à poursuivre sans faute de la tâche (verrou
 * perdu) : l'avancement est déjà enregistré. Le worker remet la tâche en file sans consommer de tentative.
 */
export class InterruptedError extends Error {
  constructor() {
    super('interrupted');
    this.name = 'InterruptedError';
  }
}

/** Délai avant la reprise d'une tâche interrompue. */
export const INTERRUPTED_RETRY_MS = 60_000;

// Spec : 3 reprises (1 min, 10 min, 1 h) après la première tentative, soit 4 tentatives.
export const DEFAULT_MAX_ATTEMPTS = 4;
export const MAX_DEDUPE_KEY_LENGTH = 191;
export const BACKOFF_MS = [60_000, 600_000, 3_600_000];
export const STALE_AFTER_MS = 15 * 60_000;
const MAX_ERROR_LENGTH = 2000;
const CANDIDATES = 5;

export function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return (header as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}

export async function enqueue(db: DbOrTx, input: JobInput, now: Date): Promise<string | null> {
  if (input.dedupeKey !== undefined && input.dedupeKey.length > MAX_DEDUPE_KEY_LENGTH) {
    throw new Error(`dedupeKey trop longue (${input.dedupeKey.length} > ${MAX_DEDUPE_KEY_LENGTH})`);
  }
  const id = randomUUID();
  try {
    await db.insert(jobs).values({
      id,
      type: input.type,
      payload: input.payload ?? {},
      runAfter: input.runAt ?? now,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      dedupeKey: input.dedupeKey ?? null,
      createdAt: now,
    });
    return id;
  } catch (err) {
    if (input.dedupeKey !== undefined && isDuplicateEntry(err)) return null;
    throw err;
  }
}

export async function getJob(db: Db, id: string): Promise<Job | null> {
  const rows = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Réserve une tâche prête (sans SKIP LOCKED : UPDATE conditionnel, affectedRows = 1 ⇒ réservée). */
export async function claimJob(db: Db, workerId: string, now: Date, types?: string[]): Promise<Job | null> {
  const candidates = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, 'queued'), lte(jobs.runAfter, now), types ? inArray(jobs.type, types) : undefined))
    .orderBy(asc(jobs.runAfter))
    .limit(CANDIDATES);
  for (const { id } of candidates) {
    const res = await db
      .update(jobs)
      .set({ status: 'running', lockedBy: workerId, lockedAt: now, attempts: sql`${jobs.attempts} + 1` })
      .where(and(eq(jobs.id, id), eq(jobs.status, 'queued')));
    if (affectedRows(res) === 1) return getJob(db, id);
  }
  return null;
}

const ownedBy = (id: string, workerId: string) =>
  and(eq(jobs.id, id), eq(jobs.status, 'running'), eq(jobs.lockedBy, workerId));

function warnIfLost(res: unknown, job: Job, workerId: string): void {
  if (affectedRows(res) === 0) console.warn('job ownership lost', { jobId: job.id, workerId });
}

export async function completeJob(db: Db, job: Job, workerId: string, now: Date): Promise<void> {
  const res = await db
    .update(jobs)
    .set({ status: 'done', finishedAt: now, lockedAt: null, lockedBy: null, error: null })
    .where(ownedBy(job.id, workerId));
  warnIfLost(res, job, workerId);
}

export async function failJob(
  db: Db,
  job: Job,
  workerId: string,
  now: Date,
  message: string,
  permanent = false,
): Promise<void> {
  const error = message.slice(0, MAX_ERROR_LENGTH);
  if (!permanent && job.attempts < job.maxAttempts) {
    const delay = BACKOFF_MS[Math.min(job.attempts, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
    const res = await db
      .update(jobs)
      .set({ status: 'queued', runAfter: new Date(now.getTime() + delay), error, lockedAt: null, lockedBy: null })
      .where(ownedBy(job.id, workerId));
    warnIfLost(res, job, workerId);
    return;
  }
  const res = await db
    .update(jobs)
    .set({ status: 'failed', error, finishedAt: now, lockedAt: null, lockedBy: null })
    .where(ownedBy(job.id, workerId));
  warnIfLost(res, job, workerId);
}

/**
 * Tâche interrompue (`InterruptedError`) : remise en file à +1 min, la tentative réservée est rendue (un redémarrage ou
 * une perte de verrou pendant un long rattrapage ne doit pas épuiser les reprises).
 */
export async function requeueInterrupted(db: Db, job: Job, workerId: string, now: Date): Promise<void> {
  const res = await db
    .update(jobs)
    .set({
      status: 'queued',
      attempts: sql`GREATEST(${jobs.attempts} - 1, 0)`,
      runAfter: new Date(now.getTime() + INTERRUPTED_RETRY_MS),
      error: 'interrupted',
      lockedAt: null,
      lockedBy: null,
    })
    .where(ownedBy(job.id, workerId));
  warnIfLost(res, job, workerId);
}

/** Enregistre l'avancement et sert de signe de vie (repousse le délai de reprise). */
export async function updateProgress(
  db: Db,
  job: Job,
  workerId: string,
  now: Date,
  progress: Record<string, unknown>,
): Promise<void> {
  const res = await db.update(jobs).set({ progress, lockedAt: now }).where(ownedBy(job.id, workerId));
  warnIfLost(res, job, workerId);
}

/**
 * Remet en file les tâches `running` sans nouvelles depuis 15 min. Une tâche qui a déjà épuisé
 * ses tentatives passe en `failed` au lieu d'être rejouée indéfiniment.
 */
export async function recoverStaleJobs(
  db: Db,
  now: Date,
): Promise<{ requeued: number; failed: number; failedJobs: Job[] }> {
  const limit = new Date(now.getTime() - STALE_AFTER_MS);
  const stale = and(eq(jobs.status, 'running'), lt(jobs.lockedAt, limit));
  const exhausted = and(stale, sql`${jobs.attempts} >= ${jobs.maxAttempts}`);
  // Tâches échues sélectionnées puis passées `failed` une à une, par identifiant et sous la même condition d'état :
  // seules celles réellement mises à jour sont renvoyées (à journaliser par l'appelant).
  const candidates = await db.select().from(jobs).where(exhausted);
  const failedJobs: Job[] = [];
  for (const job of candidates) {
    const res = await db
      .update(jobs)
      .set({ status: 'failed', error: 'stale_timeout', finishedAt: now, lockedAt: null, lockedBy: null })
      .where(and(eq(jobs.id, job.id), exhausted));
    if (affectedRows(res) === 1) failedJobs.push({ ...job, status: 'failed', error: 'stale_timeout', finishedAt: now });
  }
  const failed = failedJobs.length;
  const requeuedRes = await db.update(jobs).set({ status: 'queued', lockedAt: null, lockedBy: null }).where(stale);
  return { requeued: affectedRows(requeuedRes), failed, failedJobs };
}
