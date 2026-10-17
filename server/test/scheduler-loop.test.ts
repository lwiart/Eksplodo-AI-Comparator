import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { jobs } from '../src/db/schema/jobs.js';
import { startSchedulerLoop } from '../src/modules/jobs/scheduler-loop.js';
import { appSchedules } from '../src/modules/jobs/schedules.js';
import { createTestDb } from './helpers/test-db.js';

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition non atteinte');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('appSchedules', () => {
  test('purge du journal des erreurs à 03:30, récapitulatif des erreurs à 07:30, catalogue OpenRouter à 06:00 (heure de Paris)', () => {
    const entries = appSchedules();
    expect(entries.map((e) => e.key)).toEqual(['errors-purge', 'error-digest', 'catalog-refresh']);
    expect(entries[0]!.times).toEqual(['03:30']);
    expect(entries[1]!.times).toEqual(['07:30']);
    expect(entries[2]!.times).toEqual(['06:00']);
    const slot = new Date('2026-10-11T04:00:00Z');
    expect(entries.flatMap((e) => e.build(slot))).toEqual([{ type: 'errors_purge' }, { type: 'error_digest' }, { type: 'catalog_refresh' }]);
  });
});

describe('boucle de planification', () => {
  const dbs: Awaited<ReturnType<typeof createTestDb>>[] = [];
  afterEach(async () => {
    await Promise.all(dbs.splice(0).map((d) => d.destroy()));
  }, 60_000);
  async function fresh() {
    const d = await createTestDb();
    dbs.push(d);
    return d.db;
  }

  test('à 07:30 Paris : une tâche error_digest, la purge de 03:30 et le catalogue de 06:00, une seule fois malgré plusieurs passages', async () => {
    const db = await fresh();
    const clock = vi.fn(() => new Date('2026-10-11T05:30:30Z')); // 07:30:30 à Paris
    const loop = startSchedulerLoop({ db, schedules: appSchedules(), clock, logger: logger() }, { intervalMs: 5 });
    try {
      await until(() => clock.mock.calls.length >= 3); // au moins trois passages
    } finally {
      await loop.stop();
    }
    const rows = await db.select().from(jobs);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual([
      'catalog_refresh:catalog-refresh:2026-10-11T04:00:00.000Z',
      'error_digest:error-digest:2026-10-11T05:30:00.000Z',
      'errors_purge:errors-purge:2026-10-11T01:30:00.000Z',
    ]);
    expect(rows.every((r) => r.status === 'queued')).toBe(true);
  });

  test('premier passage immédiat : tâche abandonnée remise en file', async () => {
    const db = await fresh();
    const now = new Date('2026-10-11T09:00:00Z');
    const id = randomUUID();
    await db.insert(jobs).values({
      id,
      type: 'demo',
      payload: {},
      status: 'running',
      attempts: 1,
      runAfter: now,
      lockedAt: new Date(now.getTime() - 16 * 60_000),
      lockedBy: 'mort',
      createdAt: now,
    });
    const clock = vi.fn(() => now);
    const loop = startSchedulerLoop({ db, schedules: [], clock, logger: logger() }, { intervalMs: 60_000 });
    await until(() => clock.mock.calls.length >= 1);
    await loop.stop(); // attend la fin du passage en cours
    const [row] = await db.select().from(jobs);
    expect(row).toMatchObject({ id, status: 'queued', lockedBy: null });
  });

  test('entrée de planification invalide : échec immédiat au démarrage', () => {
    const bad = { key: 'x', times: ['6:00'], build: () => [] };
    expect(() =>
      startSchedulerLoop({ db: {} as never, schedules: [bad], clock: () => new Date(), logger: logger() }, { intervalMs: 60_000 }),
    ).toThrow('Heure de planification invalide');
  });

  test('erreur pendant un passage : journalisée, la boucle continue', async () => {
    const failing = { select: () => { throw new Error('base perdue'); }, update: () => { throw new Error('base perdue'); } };
    const log = logger();
    const clock = vi.fn(() => new Date('2026-10-11T09:00:00Z'));
    const loop = startSchedulerLoop({ db: failing as never, schedules: [], clock, logger: log }, { intervalMs: 5 });
    try {
      await until(() => clock.mock.calls.length >= 2);
    } finally {
      await loop.stop();
    }
    expect(log.error).toHaveBeenCalled();
  });
});
