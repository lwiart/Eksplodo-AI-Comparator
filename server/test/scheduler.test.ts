import { afterEach, describe, expect, test } from 'vitest';
import { jobs } from '../src/db/schema/jobs.js';
import { appSchedules } from '../src/modules/jobs/schedules.js';
import { scheduleDueJobs, type ScheduleEntry } from '../src/modules/jobs/scheduler.js';
import { buildTestApp, type TestApp } from './helpers/test-app.js';
import { createTestDb } from './helpers/test-db.js';

const entry: ScheduleEntry = {
  key: 'demo',
  times: ['06:00', '11:00', '15:00', '19:00'],
  build: () => [{ type: 'demo' }],
};

describe('planificateur', () => {
  const dbs: Awaited<ReturnType<typeof createTestDb>>[] = [];
  afterEach(async () => {
    await Promise.all(dbs.splice(0).map((d) => d.destroy()));
  }, 60_000);
  async function fresh() {
    const d = await createTestDb();
    dbs.push(d);
    return d.db;
  }

  test('crée le dernier créneau échu, une seule fois', async () => {
    const db = await fresh();
    const now = new Date('2026-10-10T07:05:00Z'); // 09:05 à Paris (UTC+2)
    expect(await scheduleDueJobs(db, [entry], now)).toBe(1);
    expect(await scheduleDueJobs(db, [entry], now)).toBe(0);
    const rows = await db.select().from(jobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupeKey).toBe('demo:demo:2026-10-10T04:00:00.000Z');
  });

  test('après une longue veille, seul le dernier créneau manqué est créé', async () => {
    const db = await fresh();
    const now = new Date('2026-10-10T18:30:00Z'); // 20:30 Paris
    expect(await scheduleDueJobs(db, [entry], now)).toBe(1);
    const rows = await db.select().from(jobs);
    expect(rows[0]!.dedupeKey).toContain('2026-10-10T17:00:00.000Z'); // 19:00 Paris
  });

  test('avant le premier créneau du jour, reprend celui de la veille', async () => {
    const db = await fresh();
    const now = new Date('2026-10-10T02:00:00Z'); // 04:00 Paris
    expect(await scheduleDueJobs(db, [entry], now)).toBe(1);
    const rows = await db.select().from(jobs);
    expect(rows[0]!.dedupeKey).toContain('2026-10-09T17:00:00.000Z');
  });

  test('changement d’heure : 06:00 Paris le 2026-10-25 = 05:00Z', async () => {
    const db = await fresh();
    const now = new Date('2026-10-25T07:00:00Z');
    expect(await scheduleDueJobs(db, [{ ...entry, times: ['06:00'] }], now)).toBe(1);
    const rows = await db.select().from(jobs);
    expect(rows[0]!.dedupeKey).toContain('2026-10-25T05:00:00.000Z');
  });

  test('entrée sans horaire : rien n’est créé', async () => {
    const db = await fresh();
    expect(await scheduleDueJobs(db, [{ ...entry, times: [] }], new Date('2026-10-10T08:00:00Z'))).toBe(0);
  });

  test('horaires invalides refusés avant tout travail en base', async () => {
    const db = await fresh();
    for (const bad of ['24:00', '12:60', '9:30', '06:0', 'abc']) {
      await expect(scheduleDueJobs(db, [{ ...entry, times: ['06:00', bad] }], new Date('2026-10-10T07:05:00Z'))).rejects.toThrow(
        /Heure de planification invalide/,
      );
    }
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  test('plusieurs tâches par créneau : une clé par type', async () => {
    const db = await fresh();
    const multi: ScheduleEntry = {
      key: 'multi',
      times: ['06:00'],
      build: () => [{ type: 'a' }, { type: 'b' }],
    };
    expect(await scheduleDueJobs(db, [multi], new Date('2026-10-10T07:05:00Z'))).toBe(2);
  });
});

describe('/internal/tick', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.destroy();
    t = undefined;
  }, 60_000);

  test('sans secret → 401, mauvais secret → 401, avec secret → 200', async () => {
    t = await buildTestApp({ now: new Date('2026-10-10T07:05:00Z'), schedules: [entry] });
    expect((await t.app.inject({ method: 'POST', url: '/internal/tick' })).statusCode).toBe(401);
    const bad = await t.app.inject({ method: 'POST', url: '/internal/tick', headers: { 'x-cron-secret': 'y'.repeat(32) } });
    expect(bad.statusCode).toBe(401);
    const short = await t.app.inject({ method: 'POST', url: '/internal/tick', headers: { 'x-cron-secret': 'x' } });
    expect(short.statusCode).toBe(401);
    const ok = await t.app.inject({ method: 'POST', url: '/internal/tick', headers: { 'x-cron-secret': 'x'.repeat(32) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ recovered: 0, failedStale: 0, scheduled: 1, runsEnqueued: 0 });
    const again = await t.app.inject({ method: 'POST', url: '/internal/tick', headers: { 'x-cron-secret': 'x'.repeat(32) } });
    expect(again.json()).toEqual({ recovered: 0, failedStale: 0, scheduled: 0, runsEnqueued: 0 });
  });
});

describe('planification applicative', () => {
  test('la tâche catalog_refresh est planifiée à 06:00 heure de Paris', async () => {
    const d = await createTestDb();
    try {
      await scheduleDueJobs(d.db, appSchedules(), new Date('2026-03-10T05:01:00Z')); // 06:01 à Paris (UTC+1)
      const rows = (await d.db.select().from(jobs)).filter((r) => r.type === 'catalog_refresh');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dedupeKey).toContain('2026-03-10T05:00:00.000Z');
    } finally {
      await d.destroy();
    }
  });
});
