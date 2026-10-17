import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { jobs } from '../src/db/schema/jobs.js';
import { BACKOFF_MS, InterruptedError, claimJob, enqueue, getJob, recoverStaleJobs, type JobHandlers } from '../src/modules/jobs/queue.js';
import { runWorkerOnce, startWorker } from '../src/modules/jobs/worker.js';
import { createTestClock, type TestClock } from './helpers/test-clock.js';
import { createTestDb } from './helpers/test-db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let clock: TestClock;
const deps = () => ({ db: t.db, clock: () => clock.now(), workerId: 'w1' });

beforeEach(async () => {
  clock = createTestClock(new Date('2026-10-10T10:00:00.000Z'));
  t = await createTestDb();
});
afterEach(async () => {
  await t.destroy();
}, 60_000);

describe('file de tâches', () => {
  test('une tâche est exécutée puis marquée terminée', async () => {
    const id = (await enqueue(t.db, { type: 'noop' }, clock.now()))!;
    const ran: string[] = [];
    const handlers: JobHandlers = {
      noop: async (j) => {
        ran.push(j.id);
      },
    };
    expect(await runWorkerOnce(deps(), handlers)).toBe(true);
    expect(ran).toEqual([id]);
    const job = (await getJob(t.db, id))!;
    expect(job.status).toBe('done');
    expect(job.finishedAt).not.toBeNull();
    expect(await runWorkerOnce(deps(), handlers)).toBe(false);
  });

  test('échecs : reprises à +1 min, +10 min, +1 h, puis échec définitif (4 tentatives)', async () => {
    const id = (await enqueue(t.db, { type: 'boom' }, clock.now()))!;
    const handlers: JobHandlers = {
      boom: async () => {
        throw new Error('exploser');
      },
    };
    expect(BACKOFF_MS).toEqual([60_000, 600_000, 3_600_000]);

    expect(await runWorkerOnce(deps(), handlers)).toBe(true);
    let job = (await getJob(t.db, id))!;
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(1);
    expect(job.runAfter.getTime()).toBe(clock.now().getTime() + 60_000);
    expect(await runWorkerOnce(deps(), handlers)).toBe(false);

    clock.advance(60_000);
    expect(await runWorkerOnce(deps(), handlers)).toBe(true);
    job = (await getJob(t.db, id))!;
    expect(job.status).toBe('queued');
    expect(job.runAfter.getTime()).toBe(clock.now().getTime() + 600_000);

    clock.advance(600_000);
    expect(await runWorkerOnce(deps(), handlers)).toBe(true);
    job = (await getJob(t.db, id))!;
    expect(job.status).toBe('queued');
    expect(job.runAfter.getTime()).toBe(clock.now().getTime() + 3_600_000);

    clock.advance(3_600_000);
    expect(await runWorkerOnce(deps(), handlers)).toBe(true);
    job = (await getJob(t.db, id))!;
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(4);
    expect(job.error).toContain('exploser');
    expect(job.finishedAt).not.toBeNull();
  });

  test('type inconnu : échec définitif unknown_job_type', async () => {
    const id = (await enqueue(t.db, { type: 'inconnu' }, clock.now()))!;
    expect(await runWorkerOnce(deps(), {})).toBe(true);
    const job = (await getJob(t.db, id))!;
    expect(job.status).toBe('failed');
    expect(job.error).toBe('unknown_job_type');
  });

  test('deux workers simultanés n’exécutent la tâche qu’une fois', async () => {
    await enqueue(t.db, { type: 'slow' }, clock.now());
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handlers: JobHandlers = {
      slow: async () => {
        calls++;
        await gate;
      },
    };
    const both = Promise.all([
      runWorkerOnce({ ...deps(), workerId: 'w1' }, handlers),
      runWorkerOnce({ ...deps(), workerId: 'w2' }, handlers),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    release();
    const results = await both;
    expect(calls).toBe(1);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('tâche abandonnée depuis 16 min remise en file puis exécutée', async () => {
    const id = (await enqueue(t.db, { type: 'noop' }, clock.now()))!;
    await t.db
      .update(jobs)
      .set({ status: 'running', lockedBy: 'mort', lockedAt: new Date(clock.now().getTime() - 16 * 60_000), attempts: 1 })
      .where(eq(jobs.id, id));
    expect(await recoverStaleJobs(t.db, clock.now())).toMatchObject({ requeued: 1, failed: 0 });
    expect((await getJob(t.db, id))!.status).toBe('queued');
    expect(await runWorkerOnce(deps(), { noop: async () => {} })).toBe(true);
    expect((await getJob(t.db, id))!.status).toBe('done');
  });

  test('une tâche running depuis 5 min n’est pas reprise', async () => {
    const id = (await enqueue(t.db, { type: 'noop' }, clock.now()))!;
    await t.db
      .update(jobs)
      .set({ status: 'running', lockedBy: 'vivant', lockedAt: new Date(clock.now().getTime() - 5 * 60_000) })
      .where(eq(jobs.id, id));
    expect(await recoverStaleJobs(t.db, clock.now())).toMatchObject({ requeued: 0, failed: 0 });
  });

  test('reportProgress enregistre l’avancement', async () => {
    const id = (await enqueue(t.db, { type: 'p' }, clock.now()))!;
    await runWorkerOnce(deps(), {
      p: async (_j, ctx) => {
        await ctx.reportProgress({ done: 3, total: 10 });
      },
    });
    expect((await getJob(t.db, id))!.progress).toEqual({ done: 3, total: 10 });
  });

  test('dedupeKey : second enqueue renvoie null, autres erreurs propagées', async () => {
    expect(await enqueue(t.db, { type: 'a', dedupeKey: 'k1' }, clock.now())).toEqual(expect.any(String));
    expect(await enqueue(t.db, { type: 'a', dedupeKey: 'k1' }, clock.now())).toBeNull();
    await expect(enqueue(t.db, { type: 'x'.repeat(100) }, clock.now())).rejects.toThrow();
  });

  test('payload transmis ; message d’erreur tronqué à 2000 caractères', async () => {
    const id = (await enqueue(t.db, { type: 'big', payload: { a: 1 }, maxAttempts: 1 }, clock.now()))!;
    let seen: unknown;
    await runWorkerOnce(deps(), {
      big: async (j) => {
        seen = j.payload;
        throw new Error('e'.repeat(5000));
      },
    });
    expect(seen).toEqual({ a: 1 });
    const job = (await getJob(t.db, id))!;
    expect(job.status).toBe('failed');
    expect(job.error!.length).toBe(2000);
  });

  test('startWorker exécute les tâches puis attend la tâche en cours à l’arrêt', async () => {
    const id = (await enqueue(t.db, { type: 'noop' }, clock.now()))!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const worker = startWorker(
      deps(),
      {
        noop: async () => {
          started = true;
          await gate;
        },
      },
      { intervalMs: 20 },
    );
    try {
      const deadline = Date.now() + 5000;
      while (!started && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(started).toBe(true);
      let stopped = false;
      const stopping = worker.stop().then(() => (stopped = true));
      await new Promise((r) => setTimeout(r, 100));
      expect(stopped).toBe(false);
      release();
      await stopping;
    } finally {
      release();
      await worker.stop();
    }
    expect((await getJob(t.db, id))!.status).toBe('done');
  });

  test('handler bloqué : délai dépassé → signal annulé, échec "timeout" avec reprise, la boucle continue', async () => {
    const id = (await enqueue(t.db, { type: 'hang' }, clock.now()))!;
    let aborted = false;
    const handlers: JobHandlers = {
      hang: (_j, ctx) =>
        new Promise<void>(() => {
          ctx.signal.addEventListener('abort', () => (aborted = true));
        }),
    };
    expect(await runWorkerOnce({ ...deps(), jobTimeoutMs: 50 }, handlers)).toBe(true);
    expect(aborted).toBe(true);
    const job = (await getJob(t.db, id))!;
    expect(job.status).toBe('queued');
    expect(job.error).toBe('timeout');
    expect(job.runAfter.getTime()).toBe(clock.now().getTime() + 60_000);
  });

  test('perte de verrou : avertissement journalisé, résultat de l’autre worker préservé', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const id = (await enqueue(t.db, { type: 'x' }, clock.now()))!;
      await runWorkerOnce(deps(), {
        x: async (j) => {
          await t.db.update(jobs).set({ lockedBy: 'autre' }).where(eq(jobs.id, j.id));
        },
      });
      expect(warn).toHaveBeenCalledWith('job ownership lost', { jobId: id, workerId: 'w1' });
      expect((await getJob(t.db, id))!.status).toBe('running');
    } finally {
      warn.mockRestore();
    }
  });

  test('dedupeKey de plus de 191 caractères refusée', async () => {
    await expect(enqueue(t.db, { type: 'a', dedupeKey: 'k'.repeat(192) }, clock.now())).rejects.toThrow(/dedupeKey trop longue/);
    expect(await enqueue(t.db, { type: 'a', dedupeKey: 'k'.repeat(191) }, clock.now())).toEqual(expect.any(String));
  });

  test('maxAttempts par défaut = 4', async () => {
    const id = (await enqueue(t.db, { type: 'a' }, clock.now()))!;
    expect((await getJob(t.db, id))!.maxAttempts).toBe(4);
  });

  test('tâche abandonnée aux tentatives épuisées : échec stale_timeout', async () => {
    const id = (await enqueue(t.db, { type: 'a' }, clock.now()))!;
    await t.db
      .update(jobs)
      .set({ status: 'running', lockedBy: 'mort', lockedAt: new Date(clock.now().getTime() - 16 * 60_000), attempts: 4 })
      .where(eq(jobs.id, id));
    expect(await recoverStaleJobs(t.db, clock.now())).toMatchObject({ requeued: 0, failed: 1 });
    expect((await getJob(t.db, id))!.error).toBe('stale_timeout');
  });

  test('signal du processus annulé : la tâche en cours est interrompue et remise en file, aucune autre réservée', async () => {
    const first = (await enqueue(t.db, { type: 'long' }, clock.now()))!;
    const stopping = new AbortController();
    let started = false;
    const handlers: JobHandlers = {
      long: (_job, ctx) =>
        new Promise<void>((_, reject) => {
          started = true;
          ctx.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
        }),
    };
    const worker = startWorker({ ...deps(), signal: stopping.signal }, handlers, { intervalMs: 10 });
    while (!started) await new Promise((r) => setTimeout(r, 5));
    const second = (await enqueue(t.db, { type: 'long' }, clock.now()))!;
    stopping.abort();
    await worker.stop();
    expect(await getJob(t.db, first)).toMatchObject({ status: 'queued', error: 'interrupted', attempts: 1 });
    expect(await getJob(t.db, second)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await runWorkerOnce({ ...deps(), signal: stopping.signal }, handlers)).toBe(false);
  });

  test('InterruptedError : remise en file à +1 min sans consommer de tentative', async () => {
    const id = (await enqueue(t.db, { type: 'interrompue', maxAttempts: 4 }, clock.now()))!;
    const handlers: JobHandlers = {
      interrompue: async () => {
        throw new InterruptedError();
      },
    };
    for (let i = 0; i < 6; i++) {
      expect(await runWorkerOnce(deps(), handlers)).toBe(true);
      const job = (await getJob(t.db, id))!;
      expect(job).toMatchObject({ status: 'queued', attempts: 0, error: 'interrupted', lockedBy: null, lockedAt: null });
      expect(job.runAfter.getTime()).toBe(clock.now().getTime() + 60_000);
      expect(await runWorkerOnce(deps(), handlers)).toBe(false);
      clock.advance(60_000);
    }
  });
});

describe('voie rapide', () => {
  test('claimJob filtré par types : la voie rapide ne prend que quick_try', async () => {
    await enqueue(t.db, { type: 'run_execute' }, clock.now());
    await enqueue(t.db, { type: 'quick_try' }, clock.now());
    expect((await claimJob(t.db, 'w', clock.now(), ['quick_try']))!.type).toBe('quick_try');
    expect(await claimJob(t.db, 'w', clock.now(), ['quick_try'])).toBeNull();
    expect((await claimJob(t.db, 'w', clock.now()))!.type).toBe('run_execute');
  });

  test('startWorker avec types : n’exécute que ces types', async () => {
    await enqueue(t.db, { type: 'autre' }, clock.now());
    const quickId = (await enqueue(t.db, { type: 'quick_try' }, clock.now()))!;
    const ran: string[] = [];
    const handlers: JobHandlers = {
      quick_try: async (j) => {
        ran.push(j.type);
      },
      autre: async (j) => {
        ran.push(j.type);
      },
    };
    const w = startWorker(deps(), handlers, { intervalMs: 10, types: ['quick_try'] });
    await vi.waitFor(async () => expect((await getJob(t.db, quickId))!.status).toBe('done'));
    await w.stop();
    expect(ran).toEqual(['quick_try']);
  });
});
