import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { errorEvents } from '../src/db/schema/errors.js';
import { fingerprintOf, newReference } from '../src/modules/errors/reference.js';
import {
  markReported,
  purgeErrorEvents,
  reportError,
  reportedReference,
  redact,
  setGraveListener,
  type ErrorInput,
} from '../src/modules/errors/report.js';
import { classifyElementFailure } from '../src/modules/errors/severity.js';
import { createTestDb } from './helpers/test-db.js';

vi.mock('../src/modules/errors/reference.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/modules/errors/reference.js')>();
  return { ...orig, newReference: vi.fn(orig.newReference) };
});

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.destroy();
});
afterEach(() => {
  setGraveListener(null);
});

const T0 = new Date('2026-10-16T10:00:00Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

function input(over: Partial<ErrorInput> = {}): ErrorInput {
  return { source: 'job', origin: `origin-${randomUUID()}`, code: 'internal', message: 'boum', severity: 'normale', ...over };
}

const eventsOf = (origin: string) => t.db.select().from(errorEvents).where(eq(errorEvents.origin, origin));

describe('référence et empreinte', () => {
  test('format et alphabet', () => {
    for (let i = 0; i < 500; i++) expect(newReference()).toMatch(/^E-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
  });

  test('10 000 tirages : presque tous distincts (31^5 combinaisons : ~2 collisions attendues, l’unicité est garantie par l’index et le nouvel essai)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(newReference());
    expect(seen.size).toBeGreaterThanOrEqual(9_980);
  });

  test('empreinte : SHA-256 hexadécimal, stable, insensible aux UUID, nombres et à la casse', () => {
    const base = { source: 'job', origin: 'demo_job', code: 'internal', httpStatus: 500 };
    const a = fingerprintOf({ ...base, message: `Échec du document ${randomUUID()} après 3 essais` });
    const b = fingerprintOf({ ...base, message: `échec du document ${randomUUID()} après 12 essais` });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(fingerprintOf({ ...base, message: 'objet a1b2c3d4e5f6 introuvable' })).toBe(
      fingerprintOf({ ...base, message: 'objet 0f9e8d7c6b5a introuvable' }),
    );
    expect(fingerprintOf({ ...base, message: 'x' })).not.toBe(fingerprintOf({ ...base, code: 'auth', message: 'x' }));
    expect(fingerprintOf({ ...base, message: 'x' })).not.toBe(fingerprintOf({ ...base, httpStatus: 502, message: 'x' }));
    expect(fingerprintOf({ ...base, message: 'x' })).not.toBe(fingerprintOf({ ...base, origin: 'autre', message: 'x' }));
    // Deux messages réellement différents (hors chiffres et UUID) ne se regroupent pas.
    expect(fingerprintOf({ ...base, message: 'Connexion refusée par le serveur' })).not.toBe(
      fingerprintOf({ ...base, message: 'Délai dépassé en attendant le serveur' }),
    );
  });
});

describe('reportError : enregistrement et regroupement', () => {
  test('enregistre un événement complet et renvoie sa référence', async () => {
    const targetId = randomUUID();
    const i = input({ httpStatus: 500, stack: 'Error: boum\n    at x', target: { type: 'analysis', id: targetId } });
    const ref = await reportError(t.db, i, T0);
    expect(ref).toMatch(/^E-[A-Z2-9]{5}$/);
    const [row] = await eventsOf(i.origin);
    expect(row).toMatchObject({
      reference: ref,
      severity: 'normale',
      source: 'job',
      code: 'internal',
      httpStatus: 500,
      message: 'boum',
      stack: 'Error: boum\n    at x',
      userId: null,
      targetType: 'analysis',
      targetId,
      occurrences: 1,
      resolvedAt: null,
      notifiedAt: null,
    });
    expect(row!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.firstSeenAt).toEqual(T0);
    expect(row!.lastSeenAt).toEqual(T0);
  });

  test('deux erreurs identiques à 10 min : un événement, 2 occurrences, même référence', async () => {
    const i = input({ message: 'échec du document 12' });
    const r1 = await reportError(t.db, i, T0);
    const r2 = await reportError(t.db, { ...i, message: 'échec du document 13', userId: randomUUID() }, min(10));
    expect(r2).toBe(r1);
    const rows = await eventsOf(i.origin);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ occurrences: 2, message: 'échec du document 13' });
    expect(rows[0]!.lastSeenAt).toEqual(min(10));
    expect(rows[0]!.firstSeenAt).toEqual(T0);
    expect(rows[0]!.userId).not.toBeNull();
  });

  test('à 61 min : deux événements, deux références', async () => {
    const i = input();
    const r1 = await reportError(t.db, i, T0);
    const r2 = await reportError(t.db, i, min(61));
    expect(r2).not.toBe(r1);
    expect(await eventsOf(i.origin)).toHaveLength(2);
  });

  test('un événement marqué traité n’est pas regroupé', async () => {
    const i = input();
    const r1 = await reportError(t.db, i, T0);
    await t.db.update(errorEvents).set({ resolvedAt: min(1) }).where(eq(errorEvents.reference, r1));
    const r2 = await reportError(t.db, i, min(2));
    expect(r2).not.toBe(r1);
    expect(await eventsOf(i.origin)).toHaveLength(2);
  });

  test('200 appels identiques (concurrents) : un événement, 200 occurrences', async () => {
    const i = input();
    const refs = await Promise.all(Array.from({ length: 200 }, () => reportError(t.db, i, T0)));
    expect(new Set(refs).size).toBe(1);
    const rows = await eventsOf(i.origin);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toBe(200);
  }, 60_000);

  test('collision de référence : nouvel essai avec une autre référence', async () => {
    const first = input();
    const ref = await reportError(t.db, first, T0);
    // Les 3 premiers tirages entrent en collision avec l'événement existant, le 4e passe.
    vi.mocked(newReference).mockReturnValueOnce(ref).mockReturnValueOnce(ref).mockReturnValueOnce(ref);
    const second = input();
    const r2 = await reportError(t.db, second, T0);
    expect(r2).not.toBe(ref);
    expect(await eventsOf(second.origin)).toHaveLength(1);
  });
});

describe('reportError : masquage et troncature', () => {
  test('sk-…, AIza…, key=… et Bearer n’apparaissent ni dans le message ni dans la pile', async () => {
    const leak =
      'sk-ant-api03-ABCDEFGH12345678 ; sk-or-v1-abcdef0123456789 ; AIzaSyA1b2C3d4E5f6G7 ; https://x/models?key=AIzaSy123&a=1 ; Authorization: Bearer xyz.token';
    const i = input({ message: leak, stack: `Error: ${leak}\n    at fn (file.ts:1:1)\n    at ${leak}` });
    await reportError(t.db, i, T0);
    const [row] = await eventsOf(i.origin);
    for (const text of [row!.message, row!.stack ?? '']) {
      for (const secret of ['sk-ant-api03', 'sk-or-v1-abcdef', 'AIzaSyA1b2', 'AIzaSy123', 'Bearer xyz', 'xyz.token']) {
        expect(text).not.toContain(secret);
      }
    }
    expect(row!.message).toContain('a=1');
    expect(row!.stack).toContain('at fn (file.ts:1:1)');
  });

  test('redact : paramètre key= masqué, texte ordinaire inchangé', () => {
    expect(redact('GET /v1/models?key=abc123&x=1')).toBe('GET /v1/models?key=[clé masquée]&x=1');
    expect(redact('apiKey=secret ok')).toBe('apiKey=[clé masquée] ok');
    expect(redact('Rien à masquer ici : skip-me')).toBe('Rien à masquer ici : skip-me');
  });

  test('Bearer masqué quelle que soit la casse ou la séparation', async () => {
    const i = input({ message: 'authorization: bearer abc.def-123 ; BEARER	zzz.top ; Bearer   ghi' });
    await reportError(t.db, i, T0);
    const [row] = await eventsOf(i.origin);
    for (const leak of ['abc.def-123', 'zzz.top', 'ghi']) expect(row!.message).not.toContain(leak);
  });

  test('base qui ne répond pas : référence de secours après 4 s, avertissement sans détail', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const hanging = new Proxy(t.db, {
        get(target, prop, receiver) {
          if (prop === 'select') return () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => new Promise(() => {}) }) }) }) });
          return Reflect.get(target, prop, receiver);
        },
      });
      const p = reportError(hanging, input({ message: 'lent' }), T0);
      await vi.advanceTimersByTimeAsync(3_900);
      let done = false;
      void p.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(await p).toMatch(/^E-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls[0])).not.toContain('lent');
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  test('troncatures : message 2 000, pile 8 000', async () => {
    const i = input({ message: 'm'.repeat(5000), stack: 's'.repeat(30_000) });
    await reportError(t.db, i, T0);
    const [row] = await eventsOf(i.origin);
    expect(row!.message).toHaveLength(2000);
    expect(row!.stack).toHaveLength(8000);
  });
});

describe('reportError : robustesse et alertes', () => {
  test('table supprimée : aucune exception, une référence, un avertissement', async () => {
    const d = await createTestDb();
    try {
      await d.db.execute('DROP TABLE error_events');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ref = await reportError(d.db, input({ severity: 'grave' }), T0);
      expect(ref).toMatch(/^E-[A-Z2-9]{5}$/);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('error_events');
      warn.mockRestore();
    } finally {
      await d.destroy();
    }
  }, 60_000);

  test('onGrave : appelé pour une erreur grave (nouvelle puis regroupée), pas pour une normale ni avec noAlert', async () => {
    const onGrave = vi.fn();
    const listener = vi.fn();
    setGraveListener(listener);
    const grave = input({ severity: 'grave' });
    await reportError(t.db, grave, T0, { onGrave });
    expect(onGrave).toHaveBeenCalledTimes(1);
    expect(onGrave.mock.calls[0]![0]).toMatchObject({ fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toMatchObject({ severity: 'grave', id: onGrave.mock.calls[0]![0].id });
    await reportError(t.db, grave, min(5), { onGrave });
    expect(onGrave).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(2);

    await reportError(t.db, input({ severity: 'normale' }), T0, { onGrave });
    await reportError(t.db, input({ severity: 'grave', noAlert: true }), T0, { onGrave });
    expect(onGrave).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test('un écouteur qui lève ne fait pas échouer la journalisation', async () => {
    setGraveListener(() => {
      throw new Error('alerte cassée');
    });
    const i = input({ severity: 'grave' });
    const ref = await reportError(t.db, i, T0, {
      onGrave: () => {
        throw new Error('hook cassé');
      },
    });
    expect((await eventsOf(i.origin))[0]!.reference).toBe(ref);
  });
});

describe('marquage des erreurs déjà journalisées', () => {
  test('markReported / reportedReference', () => {
    const err = new Error('x');
    expect(reportedReference(err)).toBeNull();
    markReported(err, 'E-AAAAA');
    expect(reportedReference(err)).toBe('E-AAAAA');
    expect(reportedReference('texte')).toBeNull();
    expect(reportedReference(null)).toBeNull();
    expect(() => markReported(null, 'E-AAAAA')).not.toThrow();
    expect(() => markReported(Object.freeze(new Error('y')), 'E-AAAAA')).not.toThrow();
  });
});

describe('classification des échecs d’éléments', () => {
  test('failSeverity normale : normale ; le reste : grave', () => {
    expect(classifyElementFailure(Object.assign(new Error('x'), { failSeverity: 'normale' }))).toBe('normale');
    expect(classifyElementFailure(Object.assign(new Error('x'), { failSeverity: 'grave' }))).toBe('grave');
    expect(classifyElementFailure(new Error('inattendu'))).toBe('grave');
    expect(classifyElementFailure('texte')).toBe('grave');
  });
});

describe('purge', () => {
  test('plus de 90 jours supprimé, 89 jours conservé', async () => {
    const now = new Date('2026-10-16T03:30:00Z');
    const day = 24 * 3600 * 1000;
    const old = input();
    const recent = input();
    await reportError(t.db, old, new Date(now.getTime() - 91 * day));
    await reportError(t.db, recent, new Date(now.getTime() - 89 * day));
    const removed = await purgeErrorEvents(t.db, now);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await eventsOf(old.origin)).toHaveLength(0);
    expect(await eventsOf(recent.origin)).toHaveLength(1);
  });
});

describe("écouteurs d'alerte isolés", () => {
  test("un hook qui lève n'empêche pas l'écouteur global d'être appelé", async () => {
    const listener = vi.fn();
    setGraveListener(listener);
    await reportError(t.db, input({ severity: 'grave' }), T0, {
      onGrave: () => {
        throw new Error('hook cassé');
      },
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('un écouteur asynchrone qui rejette ne produit aucun rejet non géré', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      setGraveListener(async () => {
        throw new Error('alerte asynchrone cassée');
      });
      const i = input({ severity: 'grave' });
      const ref = await reportError(t.db, i, T0, {
        onGrave: async () => {
          throw new Error('hook asynchrone cassé');
        },
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).not.toHaveBeenCalled();
      expect((await eventsOf(i.origin))[0]!.reference).toBe(ref);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('redact : formes des fournisseurs', () => {
  test.each([
    ['x-api-key: sk-ant-api03-AbCdEf123456', 'sk-ant-api03-AbCdEf123456'],
    ['X-Api-Key=abcdefghij0123456789', 'abcdefghij0123456789'],
    ['x-goog-api-key: AQ.Ab8RN6Kz-very-secret', 'AQ.Ab8RN6Kz-very-secret'],
    ['{"api_key":"mistral-0123456789abcdef"}', 'mistral-0123456789abcdef'],
    ['{"apiKey": "ds-0123456789abcdef"}', 'ds-0123456789abcdef'],
    ["{'api-key': 'tok_0123456789abcdef'}", 'tok_0123456789abcdef'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
  ])('redact masque %s', (input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[clé masquée]');
  });
  test('redact garde le nom du champ et le reste du texte', () => {
    expect(redact('{"api_key":"abc123456789","model":"gpt-x"}')).toBe('{"api_key":"[clé masquée]","model":"gpt-x"}');
  });
  test('redact ne touche pas un texte sans secret', () => {
    expect(redact('Modèle claude-opus-5-5 introuvable (404)')).toBe('Modèle claude-opus-5-5 introuvable (404)');
  });
});
