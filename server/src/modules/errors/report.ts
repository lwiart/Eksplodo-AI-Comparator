import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { errorEvents } from '../../db/schema/errors.js';
import type { JobHandler } from '../jobs/queue.js';
import { fingerprintOf, newReference } from './reference.js';
import { isDuplicateEntry } from '../../lib/db-errors.js';

export type ErrorInput = {
  source: 'request' | 'job' | 'external' | 'mail';
  origin: string;
  code: string;
  httpStatus?: number | null;
  message: string;
  stack?: string | null;
  severity: 'grave' | 'normale';
  userId?: string | null;
  /** Objet concerné (ex. `{ type: 'job', id }`) ; 30 caractères au plus pour le type. */
  target?: { type: string; id: string } | null;
  /** Pas d'alerte (ni `hooks.onGrave` ni l'écouteur global) : utilisé pour journaliser un échec d'envoi d'e-mail. */
  noAlert?: boolean;
};

export type GraveListener = (event: { id: string; fingerprint: string; severity: 'grave' }) => void | Promise<unknown>;

export const MAX_MESSAGE = 2000;
export const MAX_STACK = 8000;
/** Un événement non traité vu depuis moins d'une heure absorbe les occurrences identiques. */
const GROUP_WINDOW_MS = 60 * 60 * 1000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DUPLICATE_RETRIES = 3;
/** Plafond de la pile avant masquage (borne le travail de `redact`). */
const MAX_RAW_STACK = 20_000;
/** Plafond du message avant masquage. */
const MAX_RAW_MESSAGE = 20_000;

let graveListener: GraveListener | null = null;

/** Écouteur unique du processus, appelé pour chaque événement grave (nouveau ou regroupé) ; `null` le retire. */
export function setGraveListener(fn: GraveListener | null): void {
  graveListener = fn;
}

/** Marque une erreur déjà journalisée, pour qu'une couche supérieure ne la journalise pas une seconde fois. */
export const REPORTED = Symbol('aic.reported');

export function markReported(err: unknown, reference: string): void {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return;
  try {
    Object.defineProperty(err, REPORTED, { value: reference, configurable: true, enumerable: false, writable: true });
  } catch {
    // objet gelé : au pire un doublon
  }
}

export function reportedReference(err: unknown): string | null {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return null;
  const v = (err as Record<symbol, unknown>)[REPORTED];
  return typeof v === 'string' ? v : null;
}

/** Une écriture à la fois par empreinte dans ce processus : 200 appels simultanés donnent un seul événement. */
const chains = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

const MASK_KEY = '[clé masquée]';

/** Valeur déjà masquée : les règles suivantes ne la masquent pas une seconde fois. */
const NOT_MASKED = String.raw`(?!\[clé masquée\])`;
const HEADER_KEY_RE = new RegExp(String.raw`\b(x-goog-api-key|x-api-key|api-key)(\s*[:=]\s*["']?)${NOT_MASKED}[^\s"',;]+`, 'gi');
const AUTHORIZATION_RE = new RegExp(String.raw`\b(authorization\s*[:=]\s*)${NOT_MASKED}(?:[A-Za-z]+\s+)?[^\s"',;]+`, 'gi');
const JSON_FIELD_RE = /(["'])(api_key|apiKey|api-key|x-api-key|x-goog-api-key|authorization|access_token|refresh_token|secret|password|token)\1(\s*:\s*)(["'])((?:\\.|(?!\4)[^\\\n\r\u2028\u2029])*)\4/gi;

/**
 * Masque les secrets de forme connue : jetons `Bearer`, clés `sk-…` (OpenRouter, OpenAI, Anthropic), clés Google
 * `AIza…`, paramètre d'URL `key=…`, en-têtes `x-api-key`, `x-goog-api-key`, `api-key` et `authorization` (tout schéma,
 * `Basic` compris) suivis de `:` ou `=`, et valeurs des champs JSON ou objet `api_key`, `apiKey`, `api-key`, `x-api-key`,
 * `x-goog-api-key`, `authorization`, `access_token`, `refresh_token`, `secret`, `password` et `token` (le nom du champ et le reste du texte sont conservés). Appliqué au message et à la pile
 * avant toute écriture en base.
 */
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, MASK_KEY)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, MASK_KEY)
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, MASK_KEY)
    .replace(/\b([A-Za-z0-9_-]*key)=[^&\s"'<>]+/gi, `$1=${MASK_KEY}`)
    .replace(HEADER_KEY_RE, `$1$2${MASK_KEY}`)
    .replace(AUTHORIZATION_RE, `$1${MASK_KEY}`)
    .replace(JSON_FIELD_RE, `$1$2$1$3$4${MASK_KEY}$4`);
}

export function mask(input: ErrorInput): { message: string; stack: string | null } {
  // Tronqué avant `redact` : le masquage d'un message énorme ne doit pas monopoliser le processus.
  const message = redact((input.message ?? '').slice(0, MAX_RAW_MESSAGE)).slice(0, MAX_MESSAGE);
  // Pile masquée ligne par ligne : le masquage des textes envoyés n'examine que le début du texte qu'on lui passe.
  const stack = input.stack
    ? input.stack
        .slice(0, MAX_RAW_STACK)
        .split('\n')
        .map((line) => redact(line))
        .join('\n')
        .slice(0, MAX_STACK)
    : null;
  return { message, stack };
}

async function write(db: Db, input: ErrorInput, now: Date): Promise<{ id: string; reference: string; fingerprint: string }> {
  const { message, stack } = mask(input);
  const origin = input.origin.slice(0, 200);
  const code = input.code.slice(0, 100);
  const httpStatus = input.httpStatus ?? null;
  const fingerprint = fingerprintOf({ source: input.source, origin, code, httpStatus, message });
  const target = input.target ? { type: input.target.type, id: input.target.id.slice(0, 36) } : null;

  return serialized(fingerprint, async () => {
    const since = new Date(now.getTime() - GROUP_WINDOW_MS);
    const [existing] = await db
      .select({ id: errorEvents.id, reference: errorEvents.reference })
      .from(errorEvents)
      .where(and(eq(errorEvents.fingerprint, fingerprint), isNull(errorEvents.resolvedAt), gt(errorEvents.lastSeenAt, since)))
      .orderBy(desc(errorEvents.lastSeenAt))
      .limit(1);
    if (existing) {
      await db
        .update(errorEvents)
        .set({
          occurrences: sql`${errorEvents.occurrences} + 1`,
          // Écriture différée : la date de l'occurrence peut être antérieure à la dernière vue, elle ne la fait pas reculer.
          lastSeenAt: sql`GREATEST(${errorEvents.lastSeenAt}, ${sql.param(now, errorEvents.lastSeenAt)})`,
          message,
          stack,
          ...(input.severity === 'grave' ? { severity: 'grave' as const } : {}),
          userId: input.userId ?? null,
          targetType: target?.type ?? null,
          targetId: target?.id ?? null,
        })
        .where(eq(errorEvents.id, existing.id));
      return { id: existing.id, reference: existing.reference, fingerprint };
    }

    const id = randomUUID();
    for (let attempt = 0; ; attempt++) {
      const reference = newReference();
      try {
        await db.insert(errorEvents).values({
          id,
          reference,
          severity: input.severity,
          source: input.source,
          origin,
          code,
          httpStatus,
          message,
          stack,
          userId: input.userId ?? null,
          targetType: target?.type ?? null,
          targetId: target?.id ?? null,
          fingerprint,
          occurrences: 1,
          firstSeenAt: now,
          lastSeenAt: now,
        });
        return { id, reference, fingerprint };
      } catch (err) {
        if (!isDuplicateEntry(err) || attempt >= DUPLICATE_RETRIES) throw err;
      }
    }
  });
}

/** Au-delà de ce délai, la base est considérée muette : la requête ou la tâche qui journalise n'attend pas davantage. */
const WRITE_TIMEOUT_MS = 4000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
    timer.unref?.();
  });
  p.catch(() => {}); // une écriture abandonnée après le délai ne doit pas produire de rejet non géré
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Appelle un crochet d'alerte sans jamais laisser fuir une exception ni un rejet de promesse. */
function safely(call: () => void | Promise<unknown>): void {
  try {
    Promise.resolve(call()).catch(() => {});
  } catch {
    // une alerte défaillante ne doit jamais faire échouer la journalisation
  }
}

function alertGrave(input: ErrorInput, saved: { id: string; fingerprint: string }, hooks?: ReportHooks): void {
  if (input.severity !== 'grave' || input.noAlert) return;
  // Un essai par appel : un crochet défaillant n'empêche pas l'écouteur du processus.
  if (hooks?.onGrave) safely(() => hooks.onGrave!({ id: saved.id, fingerprint: saved.fingerprint }));
  if (graveListener) safely(() => graveListener!({ id: saved.id, fingerprint: saved.fingerprint, severity: 'grave' }));
}

type ReportHooks = { onGrave?: (event: { id: string; fingerprint: string }) => void | Promise<unknown> };

/** Événements dont l'écriture était impossible (base injoignable), au plus 100 : les plus anciens sont abandonnés. */
const MAX_PENDING = 100;
const pending: { input: ErrorInput; at: Date }[] = [];

/** Met un événement en attente en mémoire ; il sera écrit au prochain `reportError`, `/health` ou passage du planificateur qui atteint la base. */
export function deferError(input: ErrorInput, at: Date): void {
  if (pending.length >= MAX_PENDING) pending.shift();
  pending.push({ input, at });
}

export function pendingErrorCount(): number {
  return pending.length;
}

let flushing = false;

/** Écrit la file dans l'ordre ; un élément n'est retiré qu'une fois écrit (un échec laisse le reste intact). Ne lève jamais. */
export async function flushPendingErrors(db: Db): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (pending.length > 0) {
      const item = pending[0]!;
      let saved: Awaited<ReturnType<typeof write>>;
      try {
        saved = await write(db, item.input, item.at);
      } catch {
        return;
      }
      // La borne a pu écarter cet élément pendant l'écriture : ne retirer que lui, jamais un autre.
      const i = pending.indexOf(item);
      if (i >= 0) pending.splice(i, 1);
      alertGrave(item.input, saved);
    }
  } finally {
    flushing = false;
  }
}

/**
 * Journalise une erreur et renvoie sa référence (celle de l'événement regroupé le cas échéant).
 * Ne lève jamais : si l'enregistrement échoue ou dépasse 4 s, un avertissement (nom de l'erreur seulement) est écrit et
 * une référence de secours, non enregistrée, est renvoyée.
 */
export async function reportError(db: Db, input: ErrorInput, now: Date, hooks?: ReportHooks): Promise<string> {
  try {
    const saved = await withTimeout(write(db, input, now), WRITE_TIMEOUT_MS);
    alertGrave(input, saved, hooks);
    if (pending.length > 0) await flushPendingErrors(db);
    return saved.reference;
  } catch (err) {
    console.warn('journal des erreurs : enregistrement impossible', err instanceof Error ? err.name : typeof err);
    return newReference();
  }
}

/** Supprime les événements dont la dernière occurrence date de plus de 90 jours ; renvoie leur nombre. */
export async function purgeErrorEvents(db: Db, now: Date): Promise<number> {
  const [res] = await db.delete(errorEvents).where(lt(errorEvents.lastSeenAt, new Date(now.getTime() - RETENTION_MS)));
  return res.affectedRows;
}

/** Gestionnaire de la tâche quotidienne `errors_purge`. */
export function createErrorsPurgeHandler(): JobHandler {
  return async (_job, ctx) => {
    await purgeErrorEvents(ctx.db, ctx.now());
  };
}
