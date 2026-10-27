import { expect, test } from 'vitest';
import { ER_DUP_ENTRY, ER_LOCK_DEADLOCK, errnoOf, isDuplicateEntry } from '../src/lib/db-errors.js';

/** Erreur enveloppée comme le fait Drizzle : l'erreur du pilote est rangée dans `cause`, `depth` fois. */
function wrapped(inner: object, depth: number): Error {
  let e: object = inner;
  for (let i = 0; i < depth; i++) e = new Error(`enveloppe ${i}`, { cause: e });
  return e as Error;
}

test('errnoOf : errno direct ou dans une cause, jusqu’à cinq niveaux', () => {
  expect(errnoOf({ errno: ER_DUP_ENTRY })).toBe(ER_DUP_ENTRY);
  expect(errnoOf(wrapped({ errno: ER_LOCK_DEADLOCK }, 1))).toBe(ER_LOCK_DEADLOCK);
  // Deux enveloppes : l'ancienne version (un seul niveau de cause) ne le voyait pas.
  expect(errnoOf(wrapped({ errno: ER_DUP_ENTRY }, 2))).toBe(ER_DUP_ENTRY);
  expect(errnoOf(wrapped({ errno: ER_DUP_ENTRY }, 4))).toBe(ER_DUP_ENTRY);
  expect(errnoOf(wrapped({ errno: ER_DUP_ENTRY }, 5))).toBeUndefined();
});

test('errnoOf : rien à lire → undefined (valeurs non objets, errno non numérique, cause circulaire)', () => {
  expect(errnoOf(undefined)).toBeUndefined();
  expect(errnoOf(null)).toBeUndefined();
  expect(errnoOf('ER_DUP_ENTRY')).toBeUndefined();
  expect(errnoOf(new Error('sans code'))).toBeUndefined();
  expect(errnoOf({ errno: '1062' })).toBeUndefined();
  const loop: { cause?: unknown } = {};
  loop.cause = loop;
  expect(errnoOf(loop)).toBeUndefined();
});

test('isDuplicateEntry : errno 1062 ou code ER_DUP_ENTRY, à n’importe quel niveau de cause', () => {
  expect(isDuplicateEntry({ errno: ER_DUP_ENTRY })).toBe(true);
  expect(isDuplicateEntry({ code: 'ER_DUP_ENTRY' })).toBe(true);
  expect(isDuplicateEntry(wrapped({ code: 'ER_DUP_ENTRY' }, 3))).toBe(true);
  expect(isDuplicateEntry(wrapped({ errno: ER_LOCK_DEADLOCK }, 1))).toBe(false);
  expect(isDuplicateEntry(new Error('autre'))).toBe(false);
  expect(isDuplicateEntry(undefined)).toBe(false);
});
