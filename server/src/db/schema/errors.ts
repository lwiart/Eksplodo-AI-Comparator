import { sql } from 'drizzle-orm';
import { char, datetime, index, int, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

const now = () => sql`CURRENT_TIMESTAMP(3)`;

/** Journal des erreurs : jamais de texte de document, de prompt, de réponse IA ni de secret (voir `errors/report.ts`). */
export const errorEvents = mysqlTable(
  'error_events',
  {
    id: char('id', { length: 36 }).primaryKey(),
    reference: char('reference', { length: 7 }).notNull(),
    severity: mysqlEnum('severity', ['grave', 'normale']).notNull(),
    source: mysqlEnum('source', ['request', 'job', 'external', 'mail']).notNull(),
    origin: varchar('origin', { length: 200 }).notNull(),
    code: varchar('code', { length: 100 }).notNull(),
    httpStatus: int('http_status'),
    message: text('message').notNull(),
    stack: text('stack'),
    // Sans clé étrangère : l'événement survit à la suppression de l'utilisateur.
    userId: char('user_id', { length: 36 }),
    targetType: varchar('target_type', { length: 30 }),
    targetId: char('target_id', { length: 36 }),
    fingerprint: char('fingerprint', { length: 64 }).notNull(),
    occurrences: int('occurrences').notNull().default(1),
    firstSeenAt: datetime('first_seen_at', { mode: 'date', fsp: 3 }).notNull().default(now()),
    lastSeenAt: datetime('last_seen_at', { mode: 'date', fsp: 3 }).notNull().default(now()),
    resolvedAt: datetime('resolved_at', { mode: 'date', fsp: 3 }),
    resolvedBy: char('resolved_by', { length: 36 }),
    notifiedAt: datetime('notified_at', { mode: 'date', fsp: 3 }),
  },
  (t) => [
    uniqueIndex('error_events_reference_uq').on(t.reference),
    index('error_events_last_seen_idx').on(t.lastSeenAt),
    index('error_events_severity_last_seen_idx').on(t.severity, t.lastSeenAt),
    index('error_events_fingerprint_last_seen_idx').on(t.fingerprint, t.lastSeenAt),
  ],
);
