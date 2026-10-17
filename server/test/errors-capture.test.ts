import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { errorEvents } from '../src/db/schema/errors.js';
import { jobs } from '../src/db/schema/jobs.js';
import { NotFoundError } from '../src/errors.js';
import { reportStaleJobs } from '../src/modules/errors/capture.js';
import { deferError, flushPendingErrors, markReported, pendingErrorCount, reportError, setGraveListener } from '../src/modules/errors/report.js';
import { BACKOFF_MS, InterruptedError, enqueue, getJob, recoverStaleJobs, type JobHandlers } from '../src/modules/jobs/queue.js';
import { startSchedulerLoop } from '../src/modules/jobs/scheduler-loop.js';
import { runWorkerOnce } from '../src/modules/jobs/worker.js';
import { createFakeMailer } from '../src/modules/mail/mailer.js';
import { csrfHeaders, loginAs, seedUser, testConfig, testRegistry } from './helpers/test-app.js';
import { createTestClock } from './helpers/test-clock.js';
import { createTestDb } from './helpers/test-db.js';

const REF = /^E-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.destroy();
});
beforeEach(async () => {
  await t.db.delete(errorEvents);
  await t.db.delete(jobs);
  setGraveListener(null);
});

const clock = createTestClock(new Date('2026-10-16T10:00:00.000Z'));
const all = () => t.db.select().from(errorEvents);

async function appWith(db = t.db) {
  const app = await buildApp({ config: testConfig(), clock: () => clock.now(), db, mailer: createFakeMailer(), schedules: [], registry: testRegistry() });
  app.get('/api/test/:id', async () => {
    throw new Error('boom');
  });
  app.post('/api/test-post', async () => ({ ok: true }));
  app.get('/api/test-404/:id', async () => {
    throw new NotFoundError();
  });
  app.get('/api/test-zod/:id', async () => {
    z.object({ a: z.string() }).parse({});
  });
  return app;
}

describe('gestionnaire d’erreurs Fastify', () => {
  test('erreur inattendue : 500 avec référence et événement grave au motif de route', async () => {
    const app = await appWith();
    const res = await app.inject({ method: 'GET', url: '/api/test/abc-123?q=secret' });
    expect(res.statusCode).toBe(500);
    const err = res.json().error;
    expect(err).toMatchObject({ code: 'internal', message: 'Erreur interne du serveur' });
    expect(err.reference).toMatch(REF);
    const rows = await all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'request',
      origin: 'GET /api/test/:id',
      code: 'internal',
      severity: 'grave',
      reference: err.reference,
    });
    expect(rows[0]!.message).toContain('boom');
    expect(JSON.stringify(rows[0])).not.toContain('secret');
    await app.close();
  });

  test('404 métier et 400 Zod : rien n’est journalisé', async () => {
    const app = await appWith();
    expect((await app.inject({ method: 'GET', url: '/api/test-404/x' })).statusCode).toBe(404);
    const z400 = await app.inject({ method: 'GET', url: '/api/test-zod/x' });
    expect(z400.statusCode).toBe(400);
    expect(z400.json().error.reference).toBeUndefined();
    expect(await all()).toHaveLength(0);
    await app.close();
  });

  test('4xx Fastify (JSON malformé) : rien n’est journalisé', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-post',
      headers: { ...(await csrfHeaders(app)), 'content-type': 'application/json' },
      payload: '{mal formé',
    });
    expect(res.statusCode).toBe(400);
    expect(await all()).toHaveLength(0);
    await app.close();
  });

  test('requête authentifiée en 500 : userId enregistré', async () => {
    const app = await appWith();
    const user = await seedUser(t.db, { email: 'cap@example.test', password: 'Motdepasse-12345', role: 'user' });
    const { cookie } = await loginAs(app, 'cap@example.test', 'Motdepasse-12345');
    const res = await app.inject({ method: 'GET', url: '/api/test/1', headers: { cookie } });
    expect(res.statusCode).toBe(500);
    const rows = await all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: user.id });
    await app.close();
  });

  test('erreur déjà journalisée (markReported) : pas de nouvel événement, même référence dans la réponse', async () => {
    const app = await appWith();
    app.get('/api/test-reported', async () => {
      const err = new Error('déjà journalisée');
      markReported(err, 'E-ABCDE');
      throw err;
    });
    const res = await app.inject({ method: 'GET', url: '/api/test-reported' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.reference).toBe('E-ABCDE');
    expect(await all()).toHaveLength(0);
    await app.close();
  });

  test('journal inutilisable (table supprimée) : la route répond quand même 500 avec une référence', async () => {
    const other = await createTestDb();
    try {
      const app = await appWith(other.db);
      await other.db.execute(sql.raw('DROP TABLE error_events'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await app.inject({ method: 'GET', url: '/api/test/1' });
      warn.mockRestore();
      expect(res.statusCode).toBe(500);
      expect(res.json().error.reference).toMatch(REF);
      await app.close();
    } finally {
      await other.destroy();
    }
  }, 60_000);
});

describe('/health', () => {
  test('base injoignable : événement grave en attente (100 au plus), écrit au prochain reportError', async () => {
    const lazy = createDb('mysql://u:p@127.0.0.1:1/x');
    try {
      const app = await buildApp({
        config: testConfig(),
        clock: () => clock.now(),
        db: lazy.db,
        mailer: createFakeMailer(),
        schedules: [],
        registry: testRegistry(),
      });
      for (let i = 0; i < 105; i++) expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(503);
      expect(pendingErrorCount()).toBe(100);
      await app.close();
    } finally {
      await lazy.close();
    }
    expect(await all()).toHaveLength(0);
    await reportError(t.db, { source: 'job', origin: 'x', code: 'x', message: 'x', severity: 'normale' }, clock.now());
    expect(pendingErrorCount()).toBe(0);
    const health = (await all()).filter((e) => e.origin === 'GET /health');
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({ severity: 'grave', code: 'db_unreachable', occurrences: 100 });
  }, 120_000);
});

describe('vidange de la file sans autre erreur (I1)', () => {
  const ev = () => ({ source: 'request' as const, origin: 'GET /health', code: 'db_unreachable', message: 'Base de données injoignable', severity: 'grave' as const });
  const drain = async () => {
    await flushPendingErrors(t.db);
    await t.db.delete(errorEvents);
  };

  test('flushPendingErrors écrit la file sans autre reportError', async () => {
    await drain();
    deferError(ev(), clock.now());
    await flushPendingErrors(t.db);
    expect(pendingErrorCount()).toBe(0);
    expect(await all()).toHaveLength(1);
  });

  test('panne puis retour : /health écrit l’événement différé', async () => {
    await drain();
    deferError(ev(), clock.now());
    const app = await appWith();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect(pendingErrorCount()).toBe(0);
    expect(await all()).toHaveLength(1);
    await app.close();
  });

  test('/internal/tick vide la file', async () => {
    await drain();
    deferError(ev(), clock.now());
    const app = await appWith();
    const res = await app.inject({ method: 'POST', url: '/internal/tick', headers: { 'x-cron-secret': testConfig().cronSecret } });
    expect(res.statusCode).toBe(200);
    expect(pendingErrorCount()).toBe(0);
    expect(await all()).toHaveLength(1);
    await app.close();
  });

  test('chaque passage du planificateur vide la file', async () => {
    await drain();
    deferError(ev(), clock.now());
    const loop = startSchedulerLoop(
      { db: t.db, schedules: [], clock: () => clock.now(), logger: { info: vi.fn(), error: vi.fn() } },
      { intervalMs: 60_000 },
    );
    await vi.waitFor(() => expect(pendingErrorCount()).toBe(0), { timeout: 10_000 });
    await loop.stop();
    expect(await all()).toHaveLength(1);
  });

  test('l’écriture différée d’un événement regroupé ne fait pas reculer last_seen_at', async () => {
    await drain();
    const later = new Date(clock.now().getTime() + 60_000);
    await reportError(t.db, ev(), later);
    deferError(ev(), clock.now()); // plus ancien
    await flushPendingErrors(t.db);
    const rows = await all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toBe(2);
    expect(rows[0]!.lastSeenAt.getTime()).toBe(later.getTime());
  });
});

describe('file mémoire des événements', () => {
  const ev = (origin: string) => ({ source: 'request' as const, origin, code: 'db', message: 'x', severity: 'grave' as const });

  /** Base dont la n-ième insertion échoue (1 = la première) ; enregistre l'origine de chaque insertion réussie. */
  function failingInsert(failAt: number | null) {
    const inserted: string[] = [];
    let n = 0;
    const db = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop !== 'insert') return Reflect.get(target, prop, receiver);
        return (table: never) => {
          n++;
          const builder = target.insert(table);
          const num = n;
          return new Proxy(builder, {
            get(b, p, r) {
              if (p !== 'values') return Reflect.get(b, p, r);
              return (v: { origin: string }) => {
                if (num === failAt) return Promise.reject(new Error('insertion impossible'));
                inserted.push(v.origin);
                return b.values(v as never);
              };
            },
          });
        };
      },
    });
    return { db, inserted };
  }

  test('écriture en échec au milieu de la vidange : rien de perdu, ordre conservé, borne respectée', async () => {
    await reportError(t.db, ev('purge'), clock.now()); // vide ce qui resterait d'un autre test
    expect(pendingErrorCount()).toBe(0);
    for (const o of ['a', 'b', 'c', 'd']) deferError(ev(o), clock.now());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = failingInsert(3); // 1 = événement courant, 2 = a, 3 = b (échoue)
    await reportError(first.db, ev('courant'), clock.now());
    warn.mockRestore();
    expect(first.inserted).toEqual(['courant', 'a']);
    expect(pendingErrorCount()).toBe(3);
    const second = failingInsert(null);
    await reportError(second.db, ev('suivant'), clock.now());
    expect(second.inserted).toEqual(['suivant', 'b', 'c', 'd']);
    expect(pendingErrorCount()).toBe(0);
  });

  test('deux vidanges qui se chevauchent : aucun doublon', async () => {
    await reportError(t.db, ev('purge2'), clock.now());
    for (const o of ['e', 'f']) deferError(ev(o), clock.now());
    const rec = failingInsert(null);
    await Promise.all([reportError(rec.db, ev('g'), clock.now()), reportError(rec.db, ev('h'), clock.now())]);
    expect(rec.inserted.filter((o) => o === 'e')).toHaveLength(1);
    expect(rec.inserted.filter((o) => o === 'f')).toHaveLength(1);
    expect(pendingErrorCount()).toBe(0);
  });

  test('file pleine et vidange en échec : la borne de 100 reste respectée', async () => {
    await reportError(t.db, ev('purge3'), clock.now());
    for (let i = 0; i < 100; i++) deferError(ev(`p${i}`), clock.now());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await reportError(failingInsert(2).db, ev('courant3'), clock.now());
    warn.mockRestore();
    deferError(ev('nouveau'), clock.now());
    expect(pendingErrorCount()).toBe(100);
    await reportError(t.db, ev('fin'), clock.now());
    expect(pendingErrorCount()).toBe(0);
  });
});

describe('worker et tâches abandonnées', () => {
  const deps = () => ({ db: t.db, clock: () => clock.now(), workerId: 'w1' });
  const failing = (err: () => unknown): JobHandlers => ({
    boom: async () => {
      throw err();
    },
  });
  async function runUntilDone(type: string, handlers: JobHandlers, opts: { payload?: unknown; maxAttempts?: number } = {}) {
    const id = (await enqueue(
      t.db,
      { type, payload: opts.payload, ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}) },
      clock.now(),
    ))!;
    for (let i = 0; i < 6; i++) {
      if (!(await runWorkerOnce(deps(), handlers))) break;
      clock.advance((BACKOFF_MS[i] ?? 3_600_000) + 1000); // délai de reprise écoulé (le dernier : plus d'1 h après la 3e tentative)
    }
    return id;
  }

  test('4 échecs : 3 événements normaux regroupés puis 1 grave', async () => {
    const id = await runUntilDone('boom', failing(() => new Error('exploser')), {
      payload: { analysisId: 'an-1' },
    });
    expect((await getJob(t.db, id))!.status).toBe('failed');
    const rows = await all();
    const normal = rows.filter((r) => r.severity === 'normale');
    const grave = rows.filter((r) => r.severity === 'grave');
    expect(normal).toHaveLength(1);
    expect(normal[0]).toMatchObject({
      occurrences: 3,
      source: 'job',
      origin: 'boom',
      code: 'Error',
      targetType: 'job',
      targetId: id,
    });
    expect(grave).toHaveLength(1);
    expect(grave[0]).toMatchObject({ occurrences: 1, source: 'job', origin: 'boom' });
  });

  test('échec d’une tâche error_alert : journalisé sans déclencher d’alerte', async () => {
    const listener = vi.fn();
    setGraveListener(listener);
    for (const type of ['error_alert', 'error_digest']) {
      await runUntilDone(type, { [type]: failing(() => new Error('envoi impossible')).boom! }, { maxAttempts: 1 });
    }
    const rows = (await all()).filter((r) => r.severity === 'grave');
    expect(rows.map((r) => r.origin).sort()).toEqual(['error_alert', 'error_digest']);
    expect(listener).not.toHaveBeenCalled();
    // Une autre tâche en échec définitif déclenche bien l'alerte.
    await runUntilDone('boom', failing(() => new Error('autre')), { maxAttempts: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('échec permanent (type inconnu) : 1 événement grave', async () => {
    const id = await runUntilDone('inconnu', {});
    expect((await getJob(t.db, id))!.status).toBe('failed');
    const rows = await all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      severity: 'grave',
      origin: 'inconnu',
      code: 'unknown_job_type',
      targetType: 'job',
      targetId: id,
    });
  });

  test('InterruptedError : rien n’est journalisé', async () => {
    await enqueue(t.db, { type: 'boom' }, clock.now());
    await runWorkerOnce(deps(), failing(() => new InterruptedError()));
    expect(await all()).toHaveLength(0);
  });

  test('erreur déjà marquée par markReported : aucun nouvel événement', async () => {
    const err = new Error('déjà vu');
    markReported(err, 'E-AAAAA');
    await runUntilDone('boom', failing(() => err), { maxAttempts: 1 });
    expect(await all()).toHaveLength(0);
  });

  test('tâche abandonnée remise en file (tentatives restantes) : non journalisée', async () => {
    const id = (await enqueue(t.db, { type: 'demo' }, clock.now()))!;
    await t.db
      .update(jobs)
      .set({ status: 'running', lockedBy: 'mort', lockedAt: new Date(clock.now().getTime() - 16 * 60_000), attempts: 1 })
      .where(eq(jobs.id, id));
    const res = await recoverStaleJobs(t.db, clock.now());
    expect(res).toMatchObject({ requeued: 1, failed: 0, failedJobs: [] });
    await reportStaleJobs(t.db, res.failedJobs, clock.now());
    expect(await all()).toHaveLength(0);
  });

  test('tâche abandonnée passée failed : 1 événement grave stale_timeout', async () => {
    const id = (await enqueue(t.db, { type: 'demo' }, clock.now()))!;
    await t.db
      .update(jobs)
      .set({ status: 'running', lockedBy: 'mort', lockedAt: new Date(clock.now().getTime() - 16 * 60_000), attempts: 4 })
      .where(eq(jobs.id, id));
    const { failedJobs } = await recoverStaleJobs(t.db, clock.now());
    expect(failedJobs.map((j) => j.id)).toEqual([id]);
    await reportStaleJobs(t.db, failedJobs, clock.now());
    const rows = await all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      severity: 'grave',
      code: 'stale_timeout',
      origin: 'demo',
      targetType: 'job',
      targetId: id,
    });
  });
});
