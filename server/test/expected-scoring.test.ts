import { expect, test } from 'vitest';
import { REGEX_MAX_INPUT, scoreExpected } from '../src/modules/scoring/expected.js';
import type { ExpectedConfig } from '../src/modules/tests/scoring-config.js';

test.each([
  [{ mode: 'exact', expected: 'Paris', ignoreCase: true, ignoreAccents: false }, '  paris ', 10],
  [{ mode: 'exact', expected: 'Paris', ignoreCase: false, ignoreAccents: false }, 'paris', 0],
  [{ mode: 'exact', expected: 'Ile-de-France', ignoreCase: true, ignoreAccents: true }, 'Île-de-France', 10],
  [{ mode: 'exact', expected: 'Ile-de-France', ignoreCase: true, ignoreAccents: false }, 'Île-de-France', 0],
  [{ mode: 'exact', expected: 'a  b', ignoreCase: true, ignoreAccents: false }, 'a b', 10],
  [{ mode: 'contains', items: ['Paris', 'Lyon', 'Nice'], ignoreCase: true }, 'paris et lyon', 6.7],
  [{ mode: 'contains', items: ['Paris', 'Lyon'], ignoreCase: false }, 'paris et Lyon', 5],
  [{ mode: 'contains', items: ['Paris'], ignoreCase: true }, 'rien', 0],
  [{ mode: 'regex', pattern: '^\\d{4}$', flags: 'g' }, '2026', 10],
  [{ mode: 'regex', pattern: 'paris', flags: 'i' }, 'PARIS', 10],
  [{ mode: 'regex', pattern: 'paris', flags: '' }, 'PARIS', 0],
])('%o / %s → %d', (cfg, resp, score) => {
  expect(scoreExpected(cfg as ExpectedConfig, resp).score).toBe(score);
});

test('justification de « contient » : éléments trouvés listés', () => {
  const r = scoreExpected({ mode: 'contains', items: ['Paris', 'Lyon', 'Nice'], ignoreCase: true }, 'paris et lyon');
  expect(r.rationale).toBe('2 éléments trouvés sur 3 : Paris, Lyon');
});

test('regex avec drapeaux g et y : plusieurs appels donnent le même résultat (lastIndex ignoré)', () => {
  const cfg = { mode: 'regex', pattern: 'a', flags: 'gy' } as ExpectedConfig;
  expect(scoreExpected(cfg, 'a').score).toBe(10);
  expect(scoreExpected(cfg, 'a').score).toBe(10);
});

test('regex lente : (a+)+$ sur 30 000 « a » puis « b » → 0 en moins de 2 s, justification « Expression trop lente »', () => {
  const started = Date.now();
  const r = scoreExpected({ mode: 'regex', pattern: '(a+)+$', flags: '' }, `${'a'.repeat(30_000)}b`);
  const elapsed = Date.now() - started;
  expect(r).toEqual({ score: 0, rationale: 'Expression trop lente' });
  expect(elapsed).toBeLessThan(2000);
});

test('regex testée sur les 50 000 premiers caractères seulement', () => {
  const text = `${'x'.repeat(60_000)}paris`;
  expect(REGEX_MAX_INPUT).toBe(50_000);
  expect(scoreExpected({ mode: 'regex', pattern: 'paris', flags: '' }, text).score).toBe(0);
  expect(scoreExpected({ mode: 'regex', pattern: 'paris', flags: '' }, `${'x'.repeat(49_990)}paris`).score).toBe(10);
});

test('regex refusée par le moteur (motif invalide dans un instantané) : 0, « Expression invalide », sans exception', () => {
  const config = { mode: 'regex', pattern: '(', flags: '' } as ExpectedConfig;
  expect(scoreExpected(config, 'texte')).toEqual({ score: 0, rationale: 'Expression invalide' });
});
