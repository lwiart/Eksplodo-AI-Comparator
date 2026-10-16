import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { users } from '../src/db/schema/core.js';
import { errorEvents } from '../src/db/schema/errors.js';
import { jobs } from '../src/db/schema/jobs.js';
import { reportingMailer } from '../src/modules/errors/mail-reporter.js';
import { reportedReference, setGraveListener } from '../src/modules/errors/report.js';
import { createFakeMailer, createLogMailer, type Mailer } from '../src/modules/mail/mailer.js';
import { loginAs, seedUser, testConfig } from './helpers/test-app.js';
import { createTestDb } from './helpers/test-db.js';

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
  await t.db.delete(users);
  setGraveListener(null);
});

const NOW = new Date('2026-10-16T10:00:00.000Z');
const failing = (): Mailer => ({
  delivers: true,
  send: vi.fn(async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:587 user=secret'), { code: 'ECONNREFUSED' });
  }),
});
const mailEvents = async () => (await t.db.select().from(errorEvents)).filter((r) => r.source === 'mail');
const MSG = { to: 'a@x.fr', subject: 's', text: 't', html: '<p>t</p>' };

describe('reportingMailer', () => {
  test('échec : 1 événement mail grave au message reconstruit, erreur relancée et marquée', async () => {
    const m = reportingMailer(failing(), { db: t.db, clock: () => NOW });
    let thrown: unknown;
    await m.send(MSG).catch((e) => (thrown = e));
    expect((thrown as Error).message).toContain('secret'); // l'erreur d'origine est relancée telle quelle
    expect(reportedReference(thrown)).toMatch(/^E-/);
    const rows = await mailEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: 'smtp', code: 'ECONNREFUSED', severity: 'grave', message: "Envoi d'e-mail impossible (ECONNREFUSED)" });
    expect(rows[0]!.message).not.toContain('10.0.0.1');
  });

  test('aucune alerte immédiate pour un échec d’envoi', async () => {
    const listener = vi.fn();
    setGraveListener(listener);
    await reportingMailer(failing(), { db: t.db, clock: () => NOW }).send(MSG).catch(() => {});
    expect(listener).not.toHaveBeenCalled();
  });

  test('succès : rien journalisé ; mailer sans envoi réel renvoyé tel quel', async () => {
    const ok = createFakeMailer();
    await reportingMailer(ok, { db: t.db, clock: () => NOW }).send(MSG);
    expect(ok.sent).toHaveLength(1);
    expect(await mailEvents()).toHaveLength(0);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const log = createLogMailer(logger, true);
    const wrapped = reportingMailer(log, { db: t.db, clock: () => NOW });
    expect(wrapped).toBe(log);
    expect(wrapped.delivers).toBe(false);
  });

  test('invitation dont l’envoi échoue : 1 événement mail grave, sans alerte', async () => {
    const app = await buildApp({
      config: testConfig(),
      clock: () => NOW,
      db: t.db,
      mailer: reportingMailer(failing(), { db: t.db, clock: () => NOW }),
      schedules: [],
    });
    try {
      await seedUser(t.db, { email: 'admin@x.fr', password: 'motdepasse-solide', role: 'admin' });
      const a = await loginAs(app, 'admin@x.fr', 'motdepasse-solide');
      const res = await app.inject({
        method: 'POST',
        url: '/api/users',
        headers: { cookie: a.cookie, 'x-csrf-token': a.csrf },
        payload: { email: 'nouveau@x.fr', name: 'Nouveau', role: 'admin' },
      });
      expect(res.statusCode).toBe(201);
      await vi.waitFor(async () => expect(await mailEvents()).toHaveLength(1), { timeout: 5000 });
      expect((await mailEvents())[0]).toMatchObject({ origin: 'smtp', severity: 'grave' });
      expect((await t.db.select().from(jobs)).filter((j) => j.type === 'error_alert')).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
