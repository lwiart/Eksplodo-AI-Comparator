import { and, count, desc, eq, gt, lte } from 'drizzle-orm';
import type { AppConfig } from '../../config/config.js';
import type { Db } from '../../db/client.js';
import { users } from '../../db/schema/core.js';
import { errorEvents } from '../../db/schema/errors.js';
import { enqueue, type JobHandler } from '../jobs/queue.js';
import type { Mailer, MailMessage } from '../mail/mailer.js';
import { errorAlertEmail, errorDigestEmail, type MailBody } from '../mail/templates.js';
import { readValue, writeValue } from '../settings/settings.repo.js';
import type { GraveListener } from './report.js';

export type ErrorAlertMode = 'none' | 'daily' | 'immediate';

export const ERROR_ALERT_KEY = 'notifications.errors';
export const LAST_DIGEST_KEY = 'notifications.errors.lastDigestAt';
const DEFAULT_MODE: ErrorAlertMode = 'daily';
const MODES: readonly ErrorAlertMode[] = ['none', 'daily', 'immediate'];

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TOP_ERRORS = 10;
const TOP_ORIGINS = 10;

export async function getErrorAlertMode(db: Db): Promise<ErrorAlertMode> {
  const raw = await readValue(db, ERROR_ALERT_KEY);
  return MODES.find((m) => m === raw) ?? DEFAULT_MODE;
}

export async function saveErrorAlertMode(db: Db, mode: ErrorAlertMode): Promise<void> {
  await writeValue(db, ERROR_ALERT_KEY, mode);
}

/** Date du dernier récapitulatif envoyé ; `null` si aucun. */
export async function getLastDigestAt(db: Db): Promise<Date | null> {
  const raw = await readValue(db, LAST_DIGEST_KEY);
  if (typeof raw !== 'string') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function saveLastDigestAt(db: Db, at: Date): Promise<void> {
  await writeValue(db, LAST_DIGEST_KEY, at.toISOString());
}

/** Heure UTC au format AAAAMMJJHH (clé de déduplication des alertes). */
function hourKey(d: Date): string {
  return d.toISOString().slice(0, 13).replace(/[-T]/g, '');
}

/**
 * Écouteur des erreurs graves (branché dans index.ts via `setGraveListener`) : en mode immédiat, crée une tâche
 * `error_alert`, au plus une par empreinte et par heure UTC. Ne lève jamais (une alerte perdue vaut mieux qu'une
 * journalisation en échec).
 */
export function createGraveListener(deps: { db: Db; clock: () => Date }): GraveListener {
  return async (event) => {
    try {
      if ((await getErrorAlertMode(deps.db)) !== 'immediate') return;
      const now = deps.clock();
      await enqueue(
        deps.db,
        {
          type: 'error_alert',
          payload: { eventId: event.id },
          dedupeKey: `error_alert:${event.fingerprint}:${hourKey(now)}`,
        },
        now,
      );
    } catch (err) {
      console.warn("alerte d'erreur : tâche non créée", err instanceof Error ? err.name : typeof err);
    }
  };
}

type LogFn = (obj: object, msg: string) => void;
export type NotificationDeps = {
  mailer: Mailer;
  config: Pick<AppConfig, 'appBaseUrl'>;
  logger: { warn: LogFn };
};

const journalLink = (config: Pick<AppConfig, 'appBaseUrl'>, reference?: string): string =>
  `${config.appBaseUrl}/admin/erreurs${reference ? `?ref=${encodeURIComponent(reference)}` : ''}`;

async function activeAdmins(db: Db): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active')));
  return rows.map((r) => r.email);
}

/**
 * Envoie le message destinataire par destinataire. Un échec d'envoi est journalisé par le mailer réel
 * (`reportingMailer`). La tâche n'est relancée (erreur relancée) que si aucun envoi n'a réussi : sinon un échec partiel
 * ne doit pas renvoyer l'e-mail aux destinataires déjà servis, et l'appelant marque l'événement notifié.
 */
async function sendToAll(mailer: Mailer, to: string[], body: MailBody): Promise<void> {
  let sent = 0;
  let failure: { err: unknown } | null = null;
  for (const address of to) {
    const msg: MailMessage = { to: address, ...body };
    try {
      await mailer.send(msg);
      sent++;
    } catch (err) {
      failure ??= { err };
    }
  }
  if (sent === 0 && failure) throw failure.err;
}

/** Gestionnaire `error_alert` : alerte immédiate d'un événement grave, au plus une par empreinte et par heure. */
export function createErrorAlertHandler(deps: NotificationDeps): JobHandler {
  return async (job, ctx) => {
    const eventId = (job.payload as { eventId?: unknown } | null)?.eventId;
    if (typeof eventId !== 'string') return;
    if ((await getErrorAlertMode(ctx.db)) !== 'immediate') return;
    const [event] = await ctx.db.select().from(errorEvents).where(eq(errorEvents.id, eventId)).limit(1);
    if (!event) return;
    const now = ctx.now();
    const [recent] = await ctx.db
      .select({ id: errorEvents.id })
      .from(errorEvents)
      .where(and(eq(errorEvents.fingerprint, event.fingerprint), gt(errorEvents.notifiedAt, new Date(now.getTime() - HOUR_MS))))
      .limit(1);
    if (recent) return;
    if (!deps.mailer.delivers) {
      deps.logger.warn({ reference: event.reference }, "SMTP non configuré : alerte d'erreur non envoyée");
      return;
    }
    const admins = await activeAdmins(ctx.db);
    if (admins.length === 0) return;
    const body = errorAlertEmail({
      reference: event.reference,
      origin: event.origin,
      code: event.code,
      message: event.message,
      occurrences: event.occurrences,
      link: journalLink(deps.config, event.reference),
    });
    await sendToAll(deps.mailer, admins, body);
    await ctx.db.update(errorEvents).set({ notifiedAt: now }).where(eq(errorEvents.id, event.id));
  };
}

/** Gestionnaire `error_digest` : récapitulatif des erreurs vues depuis le précédent (mode quotidien ou immédiat). */
export function createErrorDigestHandler(deps: NotificationDeps): JobHandler {
  return async (_job, ctx) => {
    const { db } = ctx;
    const mode = await getErrorAlertMode(db);
    const now = ctx.now();
    if (mode === 'none') {
      // Pas de récapitulatif, mais la date avance : en réactivant les notifications, on ne reçoit pas tout l'arriéré.
      await saveLastDigestAt(db, now);
      return;
    }
    const since = (await getLastDigestAt(db)) ?? new Date(now.getTime() - DAY_MS);
    const inPeriod = and(gt(errorEvents.lastSeenAt, since), lte(errorEvents.lastSeenAt, now));

    const [bySeverityRows, byOrigin, top] = await Promise.all([
      db.select({ severity: errorEvents.severity, n: count() }).from(errorEvents).where(inPeriod).groupBy(errorEvents.severity),
      db
        .select({ origin: errorEvents.origin, n: count() })
        .from(errorEvents)
        .where(inPeriod)
        .groupBy(errorEvents.origin)
        .orderBy(desc(count()), errorEvents.origin)
        .limit(TOP_ORIGINS),
      db
        .select({
          reference: errorEvents.reference,
          severity: errorEvents.severity,
          origin: errorEvents.origin,
          code: errorEvents.code,
          message: errorEvents.message,
          occurrences: errorEvents.occurrences,
        })
        .from(errorEvents)
        .where(inPeriod)
        .orderBy(desc(errorEvents.occurrences), desc(errorEvents.lastSeenAt), errorEvents.reference)
        .limit(TOP_ERRORS),
    ]);
    const bySeverity = { grave: 0, normale: 0 };
    for (const r of bySeverityRows) bySeverity[r.severity] = Number(r.n);
    if (bySeverity.grave + bySeverity.normale === 0) return;

    if (!deps.mailer.delivers) {
      deps.logger.warn({}, 'SMTP non configuré : récapitulatif des erreurs non envoyé');
      return;
    }
    const admins = await activeAdmins(db);
    if (admins.length === 0) return;
    const body = errorDigestEmail({
      date: now,
      bySeverity,
      byOrigin: byOrigin.map((r) => ({ origin: r.origin, count: Number(r.n) })),
      top,
      link: journalLink(deps.config),
    });
    await sendToAll(deps.mailer, admins, body);
    await saveLastDigestAt(db, now);
  };
}
