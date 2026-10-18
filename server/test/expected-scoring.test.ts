import { expect, test } from 'vitest';
import { REGEX_MAX_INPUT, scoreExpected } from '../src/modules/scoring/expected.js';
import type { ExpectedConfig } from '../src/modules/tests/scoring-config.js';

test.each([
  [{ mode: 'exact', expected: 'Paris', ignoreCase: true, ignoreAccents: false }, '  paris ', 100],
  [{ mode: 'exact', expected: 'Paris', ignoreCase: false, ignoreAccents: false }, 'paris', 0],
  [{ mode: 'exact', expected: 'Ile-de-France', ignoreCase: true, ignoreAccents: true }, 'Île-de-France', 100],
  [{ mode: 'exact', expected: 'Ile-de-France', ignoreCase: true, ignoreAccents: false }, 'Île-de-France', 0],
  [{ mode: 'exact', expected: 'a  b', ignoreCase: true, ignoreAccents: false }, 'a b', 100],
  [{ mode: 'contains', items: ['Paris', 'Lyon', 'Nice'], ignoreCase: true }, 'paris et lyon', 67],
  [{ mode: 'contains', items: ['Paris', 'Lyon'], ignoreCase: false }, 'paris et Lyon', 50],
  [{ mode: 'contains', items: ['Paris'], ignoreCase: true }, 'rien', 0],
  [{ mode: 'regex', pattern: '^\\d{4}$', flags: 'g' }, '2026', 100],
  [{ mode: 'regex', pattern: 'paris', flags: 'i' }, 'PARIS', 100],
  [{ mode: 'regex', pattern: 'paris', flags: '' }, 'PARIS', 0],
])('%o / %s → %d', (cfg, resp, score) => {
  expect(scoreExpected(cfg as ExpectedConfig, resp).score).toBe(score);
});

test('justification de « contient » : éléments trouvés puis manquants listés', () => {
  const r = scoreExpected({ mode: 'contains', items: ['Paris', 'Lyon', 'Nice'], ignoreCase: true }, 'paris et lyon');
  expect(r.rationale).toBe('2 éléments trouvés sur 3 : Paris, Lyon ; manquant : Nice');
  const none = scoreExpected({ mode: 'contains', items: ['Nice', 'Brest'], ignoreCase: true }, 'rien');
  expect(none.rationale).toBe('0 élément trouvé sur 2 ; manquants : Nice, Brest');
  const all = scoreExpected({ mode: 'contains', items: ['Paris'], ignoreCase: true }, 'Paris');
  expect(all.rationale).toBe('1 élément trouvé sur 1 : Paris');
});

test('cas réel : « 5,0 avis google » trouvé dans « **5,0** AVIS GOOGLE »', () => {
  const r = scoreExpected(
    { mode: 'contains', items: ['Eksplodo', '5,0 avis google'], ignoreCase: true },
    'Je lis **EKSPLODO** en haut, puis **5,0** AVIS GOOGLE en bas.',
  );
  expect(r).toEqual({ score: 100, rationale: '2 éléments trouvés sur 2 : Eksplodo, 5,0 avis google' });
});

test.each([
  ['gras autour d’une partie de l’élément', ['avis google'], 'Note : 5,0 **avis** google', 100],
  ['gras dans l’élément attendu', ['**5,0** avis'], '5,0 avis', 100],
  ['italique _ et * autour d’un mot', ['très bon service'], 'Un _très_ bon *service*.', 100],
  ['gras souligné __ et code `', ['agence web lyon'], '__Agence__ web `Lyon`', 100],
  ['apostrophe typographique dans la réponse', ["l'agence"], 'C’est l’agence.', 100],
  ['apostrophe typographique dans l’élément', ['l’agence'], "C'est l'agence.", 100],
  ['guillemets français et anglais unifiés', ['"Eksplodo"'], 'Le logo dit « Eksplodo » et “Eksplodo”.', 100],
  ['snake_case et 2*3 gardés tels quels', ['snake_case', '2*3'], 'Variable snake_case, calcul 2*3.', 100],
  ['un _ ou * entre deux lettres n’est pas de l’emphase', ['snakecase'], 'snake_case', 0],
])('contient, %s', (_label, items, response, score) => {
  expect(scoreExpected({ mode: 'contains', items, ignoreCase: true }, response).score).toBe(score);
});

test('exact : gras, guillemets et apostrophes typographiques ignorés des deux côtés', () => {
  const cfg = { mode: 'exact', expected: 'L’agence “Eksplodo”', ignoreCase: true, ignoreAccents: false } as ExpectedConfig;
  expect(scoreExpected(cfg, `**L'agence "Eksplodo"**`).score).toBe(100);
  expect(scoreExpected(cfg, 'L’agence Eksplodo').score).toBe(0);
});

test('regex : le motif s’applique toujours au texte brut (Markdown et apostrophes conservés)', () => {
  expect(scoreExpected({ mode: 'regex', pattern: '[*][*]5,0[*][*]', flags: '' }, '**5,0** AVIS').score).toBe(100);
  expect(scoreExpected({ mode: 'regex', pattern: '^5,0 AVIS', flags: '' }, '**5,0** AVIS').score).toBe(0);
  expect(scoreExpected({ mode: 'regex', pattern: 'l’agence', flags: '' }, "l'agence").score).toBe(0);
});

test('regex avec drapeaux g et y : plusieurs appels donnent le même résultat (lastIndex ignoré)', () => {
  const cfg = { mode: 'regex', pattern: 'a', flags: 'gy' } as ExpectedConfig;
  expect(scoreExpected(cfg, 'a').score).toBe(100);
  expect(scoreExpected(cfg, 'a').score).toBe(100);
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
  expect(scoreExpected({ mode: 'regex', pattern: 'paris', flags: '' }, `${'x'.repeat(49_990)}paris`).score).toBe(100);
});

test('regex refusée par le moteur (motif invalide dans un instantané) : 0, « Expression invalide », sans exception', () => {
  const config = { mode: 'regex', pattern: '(', flags: '' } as ExpectedConfig;
  expect(scoreExpected(config, 'texte')).toEqual({ score: 0, rationale: 'Expression invalide' });
});
