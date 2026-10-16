import { sql } from 'drizzle-orm';
import { char, datetime, index, int, json, mysqlEnum, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';

export const jobs = mysqlTable(
  'jobs',
  {
    id: char('id', { length: 36 }).primaryKey(),
    type: varchar('type', { length: 64 }).notNull(),
    payload: json('payload').notNull(),
    status: mysqlEnum('status', ['queued', 'running', 'done', 'failed']).notNull().default('queued'),
    attempts: int('attempts').notNull().default(0),
    maxAttempts: int('max_attempts').notNull().default(4),
    runAfter: datetime('run_after', { mode: 'date', fsp: 3 }).notNull(),
    lockedAt: datetime('locked_at', { mode: 'date', fsp: 3 }),
    lockedBy: varchar('locked_by', { length: 64 }),
    progress: json('progress'),
    error: text('error'),
    dedupeKey: varchar('dedupe_key', { length: 191 }).unique(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    finishedAt: datetime('finished_at', { mode: 'date', fsp: 3 }),
  },
  (t) => [
    index('jobs_status_run_after_idx').on(t.status, t.runAfter),
    // Dernière tâche d'un type.
    index('jobs_type_created_at_idx').on(t.type, t.createdAt),
  ],
);
