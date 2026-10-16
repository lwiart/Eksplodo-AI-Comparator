import type { Db } from '../../db/client.js';
import type { Job } from '../jobs/queue.js';
import { reportError } from './report.js';

/**
 * Erreur SQL (drizzle `DrizzleQueryError`, ou mysql2) : seuls le nom, le code et la requête paramétrée sont
 * journalisés. Les paramètres, le message et le SQL interpolé peuvent contenir la recherche d'un utilisateur ou du
 * texte de document. Toute autre erreur est journalisée telle quelle.
 */
export function loggableError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const e = err as Error & { params?: unknown; sql?: unknown; sqlMessage?: unknown; code?: unknown; query?: unknown };
  if (e.params === undefined && e.sql === undefined && e.sqlMessage === undefined) return err;
  const code = e.code ?? (e.cause as { code?: unknown } | undefined)?.code;
  return {
    name: e.constructor.name || e.name, // DrizzleQueryError ne renseigne pas `name`
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof e.query === 'string' ? { query: e.query } : {}),
  };
}

/** Nom, message et pile d'une erreur, après `loggableError` : une erreur SQL n'a ni son message ni sa pile. */
export function describeError(err: unknown): { name: string; message: string; stack: string | null } {
  const safe = loggableError(err);
  if (safe instanceof Error) return { name: safe.name, message: safe.message || safe.name, stack: safe.stack ?? null };
  if (safe !== null && typeof safe === 'object') {
    const s = safe as { name?: string; code?: string; query?: string };
    const name = s.name ?? 'Error';
    return { name, message: [name, s.code, s.query].filter(Boolean).join(' '), stack: null };
  }
  return { name: 'Error', message: String(safe), stack: null };
}

/** Origine d'un événement de tâche : son type. */
export function jobOrigin(job: Pick<Job, 'type'>): string {
  return job.type.slice(0, 200);
}

/** Journalise l'échec d'une tâche de fond (grave : échec définitif ; normale : une reprise suivra). */
export function reportJobFailure(
  db: Db,
  job: Job,
  failure: { code: string; message: string; stack?: string | null; severity: 'grave' | 'normale'; noAlert?: boolean },
  now: Date,
): Promise<string> {
  return reportError(
    db,
    {
      source: 'job',
      origin: jobOrigin(job),
      code: failure.code,
      message: failure.message,
      stack: failure.stack ?? null,
      severity: failure.severity,
      ...(failure.noAlert ? { noAlert: true } : {}),
      target: { type: 'job', id: job.id },
    },
    now,
  );
}

/** Tâches passées `failed` par la reprise des tâches abandonnées : un événement grave par tâche. */
export async function reportStaleJobs(db: Db, jobs: Job[], now: Date): Promise<void> {
  for (const job of jobs) {
    await reportJobFailure(
      db,
      job,
      { code: 'stale_timeout', message: 'Tâche abandonnée : aucun signe de vie depuis plus de 15 minutes', severity: 'grave' },
      now,
    );
  }
}
