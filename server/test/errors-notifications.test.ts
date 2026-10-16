import { randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { auditLog, settings, users } from '../src/db/schema/core.js';
import { errorEvents } from '../src/db/schema/errors.js';
import { jobs } from '../src/db/schema/jobs.js';
import {
  createErrorAlertHandler,
  createErrorDigestHandler,
  createGraveListener,
  getErrorAlertMode,
  getLastDigestAt,
  saveErrorAlertMode,
} from '../src/modules/errors/notifications.js';
import { newReference } from '../src/modules/errors/reference.js';
import { reportError, reportedReference, setGraveListener, type ErrorInput } from '../src/modules/errors/report.js';
import type { Job, JobContext } from '../src/modules/jobs/queue.js';
import { reportingMailer } from '../src/modules/errors/mail-reporter.js';
import { createFakeMailer, type Mailer } from '../src/modules/mail/mailer.js';
import { errorAlertEmail, errorDigestEmail } from '../src/modules/mail/templates.js';
import { buildTestApp, loginAs, seedUser, testConfig, type TestApp } from './helpers/test-app.js';
import { createTestDb } from './helpers/test-db.js';

const PW = 'motdepasse-solide';
const T0 = new Date('2026-10-16T05:30:00.000Z'); // 07:30 à Paris
const min = (base: Date, n: number) => new Date(base.getTime() + n * 60_000);
const hoursAgo = (h: number) => new Date(T0.getTime() - h * 3_600_000);

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.destroy();
});
beforeEach(async () => {
  await t.db.delete(jobs);
  await t.db.delete(errorEvents);
  await t.db.delete(auditLog);
  await t.db.delete(settings).where(like(settings.key, 'notifications.%'));
  await t.db.delete(users);
});
afterEach(() => {
  setGraveListener(null);
});

async function admin(email: string, over: { status?: 'active' | 'disabled' } = {}) {
  return seedUser(t.db, { email, password: PW, role: 'admin', name: 'Alice Admin', ...over });
}

function ctxAt(now: Date): JobContext {
  return { db: t.db, now: () => now, signal: new AbortController().signal, async reportProgress() {} };
}
const fakeJob = (type: string, payload: unknown): Job => ({ id: randomUUID(), type, payload }) as unknown as Job;

function setup(mailer: Mailer = createFakeMailer()) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = { mailer, config: testConfig(), logger };
  const alert = createErrorAlertHandler(deps);
  const digest = createErrorDigestHandler(deps);
  return {
    mailer: mailer as ReturnType<typeof createFakeMailer>,
    logger,
    runAlert: (eventId: string, now: Date) => alert(fakeJob('error_alert', { eventId }), ctxAt(now)),
    runDigest: (now: Date) => digest(fakeJob('error_digest', {}), ctxAt(now)),
  };
}

async function event(over: Partial<typeof errorEvents.$inferInsert> = {}) {
  const row: typeof errorEvents.$inferInsert = {
    id: randomUUID(),
    reference: newReference(),
    severity: 'normale',
    source: 'job',
    origin: 'error_alert',
    code: 'internal',
    message: 'boum',
    fingerprint: randomUUID().replace(/-/g, '').padEnd(64, '0'),
    firstSeenAt: hoursAgo(5),
    lastSeenAt: hoursAgo(5),
    ...over,
  };
  await t.db.insert(errorEvents).values(row);
  return row;
}

const grave = (over: Partial<ErrorInput> = {}): ErrorInput => ({
  source: 'job', origin: 'error_alert', code: 'internal', message: 'boum', severity: 'grave', ...over,
});
const queued = async (type: string) => (await t.db.select().from(jobs)).filter((j) => j.type === type);
const eventNotified = async (id: string) =>
  (await t.db.select({ n: errorEvents.notifiedAt }).from(errorEvents).where(eq(errorEvents.id, id)))[0]!.n;

describe('réglage du mode', () => {
  test('défaut quotidien, enregistrement, valeur illisible ramenée au défaut', async () => {
    expect(await getErrorAlertMode(t.db)).toBe('daily');
    await saveErrorAlertMode(t.db, 'immediate');
    expect(await getErrorAlertMode(t.db)).toBe('immediate');
    await saveErrorAlertMode(t.db, 'none');
    expect(await getErrorAlertMode(t.db)).toBe('none');
    await t.db.update(settings).set({ value: 'n_importe_quoi' }).where(eq(settings.key, 'notifications.errors'));
    expect(await getErrorAlertMode(t.db)).toBe('daily');
  });
});

describe('mode aucune notification', () => {
  test('aucun e-mail ni tâche', async () => {
    await admin('a@x.fr');
    await saveErrorAlertMode(t.db, 'none');
    const s = setup();
    const e = await event({ severity: 'grave', lastSeenAt: hoursAgo(1) });
    await s.runDigest(T0);
    await s.runAlert(e.id!, T0);
    await createGraveListener({ db: t.db, clock: () => T0 })({ id: e.id!, fingerprint: e.fingerprint!, severity: 'grave' });
    expect(s.mailer.sent).toHaveLength(0);
    expect(await queued('error_alert')).toHaveLength(0);
    expect(await getLastDigestAt(t.db)).toEqual(T0); // la date avance quand même (m4)
  });
});

describe('mode récapitulatif quotidien', () => {
  test("envoie le récapitulatif aux seuls Admin actifs, puis plus rien tant qu'il n'y a rien de nouveau", async () => {
    await admin('a@x.fr');
    await admin('b@x.fr');
    await admin('off@x.fr', { status: 'disabled' });
    await seedUser(t.db, { email: 'm@x.fr', password: PW, role: 'user' });
    await event({ severity: 'grave', origin: 'smtp', source: 'mail', occurrences: 3, lastSeenAt: hoursAgo(2) });
    await event({ origin: 'error_alert', occurrences: 7, lastSeenAt: hoursAgo(10) });
    await event({ origin: 'error_alert', lastSeenAt: hoursAgo(30) }); // trop ancien : hors des dernières 24 h
    const s = setup();
    await s.runDigest(T0);
    expect(s.mailer.sent.map((m) => m.to).sort()).toEqual(['a@x.fr', 'b@x.fr']);
    const m = s.mailer.sent[0]!;
    expect(m.subject).toBe('[Eksplodo · Comparateur IA] Récapitulatif des erreurs du 16/10/2026');
    expect(m.text).toContain('http://localhost:3000/admin/erreurs');
    expect(m.text).toMatch(/2 erreurs/);
    expect(await getLastDigestAt(t.db)).toEqual(T0);

    // Rien de nouveau depuis : aucun envoi.
    s.mailer.sent.length = 0;
    await s.runDigest(min(T0, 24 * 60));
    expect(s.mailer.sent).toHaveLength(0);

    // Une nouvelle erreur après le dernier récapitulatif : envoi, et seulement elle.
    await event({ origin: 'errors_purge', lastSeenAt: min(T0, 60) });
    await s.runDigest(min(T0, 24 * 60 + 5));
    expect(s.mailer.sent).toHaveLength(2);
    expect(s.mailer.sent[0]!.text).toContain('Purge du journal des erreurs');
    expect(s.mailer.sent[0]!.text).not.toContain("Alerte d'erreur");
  });

  test('aucune erreur : aucun e-mail', async () => {
    await admin('a@x.fr');
    const s = setup();
    await s.runDigest(T0);
    expect(s.mailer.sent).toHaveLength(0);
  });

  test("journal de production sans SMTP : rien d'envoyé ni marqué", async () => {
    await admin('a@x.fr');
    await event({ lastSeenAt: hoursAgo(1) });
    const s = setup({ delivers: false, send: vi.fn() });
    await s.runDigest(T0);
    expect(await getLastDigestAt(t.db)).toBeNull();
    expect(s.logger.warn).toHaveBeenCalled();
  });
});

describe('récapitulatif - cas limites', () => {
  test('mode aucune notification : le récapitulatif avance quand même lastDigestAt', async () => {
    await admin('a@x.fr');
    await saveErrorAlertMode(t.db, 'none');
    await event({ lastSeenAt: hoursAgo(1) });
    const s = setup();
    await s.runDigest(T0);
    expect(s.mailer.sent).toHaveLength(0);
    expect(await getLastDigestAt(t.db)).toEqual(T0);
  });

  test('envoi destinataire par destinataire : un échec partiel ne relance pas la tâche et le récapitulatif avance', async () => {
    await admin('a@x.fr');
    await admin('b@x.fr');
    await event({ lastSeenAt: hoursAgo(1) });
    const sent: string[] = [];
    const flaky: Mailer = {
      delivers: true,
      send: vi.fn(async (m) => {
        if (m.to === 'a@x.fr') throw Object.assign(new Error('refusé'), { code: 'EENVELOPE' });
        sent.push(m.to);
      }),
    };
    const s = setup(reportingMailer(flaky, { db: t.db, clock: () => T0 }));
    await s.runDigest(T0); // ne lève pas : un destinataire a été servi
    expect(sent).toEqual(['b@x.fr']);
    expect(await getLastDigestAt(t.db)).toEqual(T0);
    expect((await t.db.select().from(errorEvents)).filter((r) => r.source === 'mail')).toHaveLength(1);
  });

  test('alerte : échec partiel - événement marqué notifié, aucun échec relancé', async () => {
    await admin('a@x.fr');
    await admin('b@x.fr');
    await saveErrorAlertMode(t.db, 'immediate');
    const e = await event({ severity: 'grave', origin: 'errors_purge' });
    const flaky: Mailer = {
      delivers: true,
      send: vi.fn(async (m) => {
        if (m.to === 'a@x.fr') throw new Error('refusé');
      }),
    };
    await setup(reportingMailer(flaky, { db: t.db, clock: () => T0 })).runAlert(e.id!, T0);
    expect(await eventNotified(e.id!)).toEqual(T0);
  });

  test('passage d’heure : même erreur grave à 10:59 puis 11:01 - un seul e-mail', async () => {
    await admin('a@x.fr');
    await saveErrorAlertMode(t.db, 'immediate');
    let now = new Date('2026-10-16T10:59:00.000Z');
    setGraveListener(createGraveListener({ db: t.db, clock: () => now }));
    const s = setup();
    await reportError(t.db, grave({ origin: 'errors_purge' }), now);
    await new Promise((r) => setTimeout(r, 300));
    for (const j of await queued('error_alert')) await s.runAlert((j.payload as { eventId: string }).eventId, now);
    now = new Date('2026-10-16T11:01:00.000Z');
    await reportError(t.db, grave({ origin: 'errors_purge' }), now);
    await new Promise((r) => setTimeout(r, 300));
    expect(await queued('error_alert')).toHaveLength(2); // clés d'heures différentes
    for (const j of await queued('error_alert')) await s.runAlert((j.payload as { eventId: string }).eventId, now);
    expect(s.mailer.sent).toHaveLength(1);
  });
});

describe('mode alerte immédiate', () => {
  async function immediate() {
    await admin('a@x.fr');
    await saveErrorAlertMode(t.db, 'immediate');
    let now = T0;
    setGraveListener(createGraveListener({ db: t.db, clock: () => now }));
    const s = setup();
    return {
      s,
      at: (d: Date) => {
        now = d;
      },
      // Exécute les tâches error_alert en file, comme le worker.
      async drain(at: Date) {
        for (const j of await queued('error_alert')) {
          if (j.status !== 'queued') continue;
          await s.runAlert((j.payload as { eventId: string }).eventId, at);
          await t.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, j.id));
        }
      },
      async settle() {
        await new Promise((r) => setTimeout(r, 300)); // l'écouteur est asynchrone, sans attente de reportError
      },
    };
  }

  test('1 alerte pour une erreur grave, 0 pour une normale', async () => {
    const x = await immediate();
    await reportError(t.db, grave({ origin: 'errors_purge', message: 'illisible' }), T0);
    await reportError(t.db, grave({ severity: 'normale', origin: 'autre' }), T0);
    await x.settle();
    expect(await queued('error_alert')).toHaveLength(1);
    await x.drain(T0);
    expect(x.s.mailer.sent).toHaveLength(1);
    const m = x.s.mailer.sent[0]!;
    expect(m.to).toBe('a@x.fr');
    expect(m.subject).toBe("[Eksplodo · Comparateur IA] Erreur grave : Purge du journal des erreurs");
    expect(m.text).toContain('illisible');
    expect(m.text).toContain(`http://localhost:3000/admin/erreurs?ref=${(await t.db.select().from(errorEvents).where(eq(errorEvents.origin, 'errors_purge')))[0]!.reference}`);
    const [row] = await t.db.select().from(errorEvents).where(eq(errorEvents.origin, 'errors_purge'));
    expect(row!.notifiedAt).toEqual(T0);
  });

  test("50 erreurs graves identiques dans l'heure : 1 seule alerte ; une nouvelle après 61 minutes", async () => {
    const x = await immediate();
    for (let i = 0; i < 50; i++) await reportError(t.db, grave(), min(T0, i % 40));
    await x.settle();
    expect(await queued('error_alert')).toHaveLength(1);
    await x.drain(min(T0, 10));
    expect(x.s.mailer.sent).toHaveLength(1);

    // Encore une erreur identique plus tard dans la même heure : la clé de déduplication l'écarte.
    x.at(min(T0, 20));
    await reportError(t.db, grave(), min(T0, 20));
    await x.settle();
    await x.drain(min(T0, 21));
    expect(x.s.mailer.sent).toHaveLength(1);

    // 61 minutes après la première alerte : une nouvelle.
    x.at(min(T0, 71));
    await reportError(t.db, grave(), min(T0, 71));
    await x.settle();
    expect(await queued('error_alert')).toHaveLength(2);
    await x.drain(min(T0, 71));
    expect(x.s.mailer.sent).toHaveLength(2);
  });

  test("le gestionnaire ignore un événement dont une alerte de même empreinte est partie dans l'heure", async () => {
    await admin('a@x.fr');
    await saveErrorAlertMode(t.db, 'immediate');
    const fp = 'f'.repeat(64);
    await event({ severity: 'grave', fingerprint: fp, notifiedAt: min(T0, -30), resolvedAt: min(T0, -20) });
    const e2 = await event({ severity: 'grave', fingerprint: fp, lastSeenAt: min(T0, -1) });
    const s = setup();
    await s.runAlert(e2.id!, T0);
    expect(s.mailer.sent).toHaveLength(0);
    await s.runAlert(e2.id!, min(T0, 31)); // plus d'une heure après la précédente
    expect(s.mailer.sent).toHaveLength(1);
    expect(await eventNotified(e2.id!)).toEqual(min(T0, 31));
  });

  test('mode changé entre-temps ou événement disparu : rien', async () => {
    await admin('a@x.fr');
    await saveErrorAlertMode(t.db, 'daily');
    const e = await event({ severity: 'grave' });
    const s = setup();
    await s.runAlert(e.id!, T0);
    await saveErrorAlertMode(t.db, 'immediate');
    await s.runAlert(randomUUID(), T0);
    expect(s.mailer.sent).toHaveLength(0);
    expect(await eventNotified(e.id!)).toBeNull();
  });

  test('le récapitulatif du matin fonctionne aussi en mode immédiat', async () => {
    await admin('a@x.fr');
    await saveErrorAlertMode(t.db, 'immediate');
    await event({ severity: 'grave', lastSeenAt: hoursAgo(3) });
    const s = setup();
    await s.runDigest(T0);
    expect(s.mailer.sent).toHaveLength(1);
  });

  test("l'écouteur ne lève jamais (base injoignable)", async () => {
    const broken = {
      select: () => {
        throw new Error('base perdue');
      },
    };
    const listener = createGraveListener({ db: broken as never, clock: () => T0 });
    await expect(listener({ id: 'x', fingerprint: 'y', severity: 'grave' })).resolves.toBeUndefined();
  });
});

describe("échec d'envoi SMTP", () => {
  // Le mailer réel est décoré par `reportingMailer` (index.ts) : c'est lui qui journalise l'échec, pas `sendToAll`.
  const failing = (): Mailer =>
    reportingMailer(
      {
        delivers: true,
        send: vi.fn(async () => {
          throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:587 user=secret'), { code: 'ECONNREFUSED' });
        }),
      },
      { db: t.db, clock: () => T0 },
    );

  test('alerte : 1 événement mail grave, erreur relancée et marquée, aucune alerte en boucle', async () => {
    await admin('a@x.fr');
    await saveErrorAlertMode(t.db, 'immediate');
    setGraveListener(createGraveListener({ db: t.db, clock: () => T0 }));
    const e = await event({ severity: 'grave', origin: 'errors_purge' });
    const s = setup(failing());
    let thrown: unknown;
    await s.runAlert(e.id!, T0).catch((err) => (thrown = err));
    expect(thrown).toBeInstanceOf(Error);
    expect(reportedReference(thrown)).toMatch(/^E-/);
    await s.runAlert(e.id!, min(T0, 1)).catch(() => {}); // reprise de la file : même événement regroupé
    await new Promise((r) => setTimeout(r, 300));
    const mails = (await t.db.select().from(errorEvents)).filter((r) => r.source === 'mail');
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ origin: 'smtp', severity: 'grave', occurrences: 2 });
    expect(mails[0]!.message).not.toContain('secret');
    expect(mails[0]!.message).not.toContain('10.0.0.1');
    expect(await queued('error_alert')).toHaveLength(0);
    expect(await eventNotified(e.id!)).toBeNull();
  });

  test('récapitulatif : même journalisation, date du dernier récapitulatif inchangée', async () => {
    await admin('a@x.fr');
    await event({ lastSeenAt: hoursAgo(1) });
    const s = setup(failing());
    await expect(s.runDigest(T0)).rejects.toThrow();
    const mails = (await t.db.select().from(errorEvents)).filter((r) => r.source === 'mail');
    expect(mails).toHaveLength(1);
    expect(await getLastDigestAt(t.db)).toBeNull();
  });
});

describe('contenu des e-mails', () => {
  test('seulement les champs autorisés, HTML échappé', () => {
    const link = 'http://localhost:3000/admin/erreurs';
    const a = errorAlertEmail({
      reference: 'E-ABCDE', origin: 'error_alert', code: 'internal', message: '<script>alert(1)</script> & co',
      occurrences: 4, link,
    });
    expect(a.subject).toBe("[Eksplodo · Comparateur IA] Erreur grave : Alerte d'erreur par e-mail");
    expect(a.html).not.toContain('<script>');
    expect(a.html).toContain('&lt;script&gt;');
    for (const needle of ['E-ABCDE', 'internal', '4', link]) expect(a.text).toContain(needle);
    expect(a.text).toContain('(Administration, Journal des erreurs)');
    const d = errorDigestEmail({
      date: new Date('2026-10-16T05:30:00Z'),
      bySeverity: { grave: 1, normale: 2 },
      byOrigin: [{ origin: 'error_alert', count: 3 }],
      top: [{ reference: 'E-ABCDE', severity: 'grave', origin: 'x<b>', code: 'c', message: 'm', occurrences: 9 }],
      link,
    });
    expect(d.subject).toBe('[Eksplodo · Comparateur IA] Récapitulatif des erreurs du 16/10/2026');
    expect(d.html).not.toContain('x<b>');
    expect(d.text).toContain('E-ABCDE');
  });

  test('une pile et des champs internes présents en base ne sortent jamais', async () => {
    await admin('a@x.fr');
    await saveErrorAlertMode(t.db, 'immediate');
    const e = await event({
      severity: 'grave', stack: 'PILE-INTERDITE at secret.ts:1', userId: randomUUID(), targetType: 'job',
      targetId: randomUUID(), lastSeenAt: hoursAgo(1),
    });
    const s = setup();
    await s.runAlert(e.id!, T0);
    await s.runDigest(T0);
    expect(s.mailer.sent).toHaveLength(2);
    for (const m of s.mailer.sent) {
      for (const bad of ['PILE-INTERDITE', 'secret.ts', e.id!, e.targetId!]) {
        expect(m.text).not.toContain(bad);
        expect(m.html).not.toContain(bad);
      }
    }
  });
});

describe('API du réglage', () => {
  const apps: TestApp[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.destroy()));
  }, 60_000);

  async function api(role: 'admin' | 'user') {
    const a = await buildTestApp({ now: T0 });
    apps.push(a);
    await seedUser(a.db, { email: 'u@x.fr', password: PW, role });
    const auth = await loginAs(a.app, 'u@x.fr', PW);
    const headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrf };
    return {
      a,
      headers,
      get: () => a.app.inject({ method: 'GET', url: '/api/admin/settings/notifications', headers }),
      put: (payload: unknown, h: Record<string, string> = headers) =>
        a.app.inject({ method: 'PUT', url: '/api/admin/settings/notifications', headers: h, payload: payload as object }),
    };
  }

  test('Admin : lecture (défaut quotidien), modification, audit', async () => {
    const x = await api('admin');
    expect((await x.get()).json()).toEqual({ errorAlerts: 'daily' });
    const res = await x.put({ errorAlerts: 'immediate' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ errorAlerts: 'immediate' });
    expect((await x.get()).json()).toEqual({ errorAlerts: 'immediate' });
    expect(await getErrorAlertMode(x.a.db)).toBe('immediate');
    const rows = (await x.a.db.select().from(auditLog)).filter((r) => r.action === 'settings.notifications');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toEqual({ errorAlerts: 'immediate' });
  });

  test('valeur invalide : 400 ; sans jeton CSRF : 403', async () => {
    const x = await api('admin');
    expect((await x.put({ errorAlerts: 'toujours' })).statusCode).toBe(400);
    expect((await x.put({})).statusCode).toBe(400);
    expect((await x.put({ errorAlerts: 'none' }, { cookie: x.headers.cookie })).statusCode).toBe(403);
    expect(await getErrorAlertMode(x.a.db)).toBe('daily');
  });

  test('Utilisateur : 403 en lecture et en écriture', async () => {
    const x = await api('user');
    expect((await x.get()).statusCode).toBe(403);
    expect((await x.put({ errorAlerts: 'none' })).statusCode).toBe(403);
    expect(await getErrorAlertMode(x.a.db)).toBe('daily');
  });
});
