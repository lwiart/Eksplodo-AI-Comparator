import { afterEach, expect, test, vi } from 'vitest';
import { getAnimationsPreference, setAnimationsPreference } from './preferences';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

test('animations activées par défaut', () => {
  expect(getAnimationsPreference()).toBe(true);
});

test('préférence mémorisée', () => {
  setAnimationsPreference(false);
  expect(getAnimationsPreference()).toBe(false);
  setAnimationsPreference(true);
  expect(getAnimationsPreference()).toBe(true);
});

test('localStorage indisponible → défaut sans erreur', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('SecurityError');
  });
  expect(getAnimationsPreference()).toBe(true);
  expect(() => setAnimationsPreference(false)).not.toThrow();
});
