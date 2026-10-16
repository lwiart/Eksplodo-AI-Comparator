import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { users } from '../../db/schema/core.js';
import { errorEvents } from '../../db/schema/errors.js';
import { NotFoundError, ValidationError } from '../../errors.js';
import type { Clock } from '../../lib/clock.js';
import { audit } from '../audit/audit.js';
import { getErrorAlertMode, saveErrorAlertMode } from './notifications.js';

const PAGE_SIZE = 50;
const MAX_PAGE = 10_000;
const DAY_MS = 86_400_000;
const REFERENCE = /^E-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

/** Date ISO complète, ou date seule (AAAA-MM-JJ, en UTC). */
const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2}))?$/, 'date ISO attendue')
  .refine((s) => !Number.isNaN(new Date(s).getTime()), 'date invalide');
const dateOnly = (s: string) => s.length === 10;

const listQuery = z.object({
  from: dateParam.optional(),
  to: dateParam.optional(),
  severity: z.enum(['grave', 'normale']).optional(),
  source: z.enum(['request', 'job', 'external', 'mail']).optional(),
  origin: z.string().min(1).max(200).optional(),
  includeResolved: z.enum(['0', '1']).default('0'),
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
});

const resolveBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  resolved: z.boolean(),
});

const notificationsBody = z.object({ errorAlerts: z.enum(['none', 'daily', 'immediate']) });

const toIso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function registerErrorRoutes(app: FastifyInstance, deps: { db: Db; clock: Clock }): void {
  const { db, clock } = deps;
  const guard = { preHandler: app.requireAdmin };

  const selectEvents = () =>
    db
      .select({ e: errorEvents, userName: users.name })
      .from(errorEvents)
      // Jointure externe : l'événement survit à la suppression de l'utilisateur.
      .leftJoin(users, eq(users.id, errorEvents.userId));

  const toDto = (r: { e: typeof errorEvents.$inferSelect; userName: string | null }) => ({
    id: r.e.id,
    reference: r.e.reference,
    severity: r.e.severity,
    source: r.e.source,
    origin: r.e.origin,
    code: r.e.code,
    httpStatus: r.e.httpStatus,
    message: r.e.message,
    stack: r.e.stack,
    userId: r.e.userId,
    userName: r.userName,
    target: r.e.targetType !== null && r.e.targetId !== null ? { type: r.e.targetType, id: r.e.targetId } : null,
    occurrences: r.e.occurrences,
    firstSeenAt: r.e.firstSeenAt.toISOString(),
    lastSeenAt: r.e.lastSeenAt.toISOString(),
    resolvedAt: toIso(r.e.resolvedAt),
    notifiedAt: toIso(r.e.notifiedAt),
  });

  app.get('/api/admin/errors', guard, async (req) => {
    const q = listQuery.parse(req.query);
    const now = clock();
    const from = q.from ? new Date(q.from) : new Date(now.getTime() - 7 * DAY_MS);
    // Date seule : la journée entière est incluse.
    if (q.from && q.to && new Date(q.from).getTime() > new Date(q.to).getTime()) {
      throw new ValidationError('invalid_range', '« from » doit précéder ou égaler « to »');
    }
    const to = q.to ? new Date(new Date(q.to).getTime() + (dateOnly(q.to) ? DAY_MS - 1 : 0)) : null;

    const conds: SQL[] = [gte(errorEvents.lastSeenAt, from)];
    if (to) conds.push(lte(errorEvents.lastSeenAt, to));
    if (q.severity) conds.push(eq(errorEvents.severity, q.severity));
    if (q.source) conds.push(eq(errorEvents.source, q.source));
    if (q.origin) conds.push(eq(errorEvents.origin, q.origin));
    if (q.includeResolved === '0') conds.push(isNull(errorEvents.resolvedAt));
    const where = and(...conds);

    const [rows, [totalRow]] = await Promise.all([
      selectEvents()
        .where(where)
        .orderBy(desc(errorEvents.lastSeenAt), desc(errorEvents.id))
        .limit(PAGE_SIZE)
        .offset((q.page - 1) * PAGE_SIZE),
      db.select({ n: count() }).from(errorEvents).where(where),
    ]);
    return { items: rows.map(toDto), total: Number(totalRow?.n ?? 0), page: q.page, pageSize: PAGE_SIZE };
  });

  app.get('/api/admin/errors/summary', guard, async (req) => {
    const now = clock();
    const since24h = new Date(now.getTime() - DAY_MS);
    const since7d = new Date(now.getTime() - 7 * DAY_MS);
    const window = async (since: Date) => {
      const [r] = await db
        .select({
          total: count(),
          grave: sql<string>`COALESCE(SUM(${errorEvents.severity} = 'grave'), 0)`,
        })
        .from(errorEvents)
        .where(gte(errorEvents.lastSeenAt, since));
      return { total: Number(r?.total ?? 0), grave: Number(r?.grave ?? 0) };
    };
    const [last24h, last7d, top, [unresolved]] = await Promise.all([
      window(since24h),
      window(since7d),
      db
        .select({ origin: errorEvents.origin, n: count() })
        .from(errorEvents)
        .where(gte(errorEvents.lastSeenAt, since7d))
        .groupBy(errorEvents.origin)
        .orderBy(desc(count()), errorEvents.origin)
        .limit(3),
      db
        .select({ n: count() })
        .from(errorEvents)
        .where(and(eq(errorEvents.severity, 'grave'), isNull(errorEvents.resolvedAt))),
    ]);
    return {
      last24h,
      last7d,
      topOrigins: top.map((r) => ({ origin: r.origin, count: Number(r.n) })),
      unresolvedGrave: Number(unresolved?.n ?? 0),
    };
  });

  app.get('/api/admin/errors/by-reference/:reference', guard, async (req) => {
    const raw = z.object({ reference: z.string().max(40) }).parse(req.params).reference.trim().toUpperCase();
    const reference = raw.startsWith('E-') ? raw : `E-${raw}`;
    if (!REFERENCE.test(reference)) throw new NotFoundError();
    const [row] = await selectEvents().where(eq(errorEvents.reference, reference)).limit(1);
    if (!row) throw new NotFoundError();
    return { item: toDto(row) };
  });

  app.post('/api/admin/errors/resolve', guard, async (req) => {
    const actor = req.actor!;
    const body = resolveBody.parse(req.body);
    const set = body.resolved
      ? { resolvedAt: clock(), resolvedBy: actor.userId }
      : { resolvedAt: null, resolvedBy: null };
    // Seuls les événements dont l'état change sont comptés (une réouverture ignore les non traités).
    const state = body.resolved ? isNull(errorEvents.resolvedAt) : isNotNull(errorEvents.resolvedAt);
    const [result] = await db
      .update(errorEvents)
      .set(set)
      .where(and(inArray(errorEvents.id, body.ids), state));
    return { updated: Number(result.affectedRows) };
  });

  app.get('/api/admin/settings/notifications', guard, async (req) => {
    return { errorAlerts: await getErrorAlertMode(db) };
  });

  app.put('/api/admin/settings/notifications', guard, async (req) => {
    const actor = req.actor!;
    const body = notificationsBody.parse(req.body);
    await saveErrorAlertMode(db, body.errorAlerts);
    await audit(db, {
      actorUserId: actor.userId,
      action: 'settings.notifications',
      targetType: 'settings',
      targetId: 'notifications.errors',
      details: { errorAlerts: body.errorAlerts },
    });
    return { errorAlerts: body.errorAlerts };
  });
}
