import { expect, test } from 'vitest';
import { parseScoringConfig } from '../src/modules/tests/scoring-config.js';

test.each([
  ['expected', { mode: 'exact', expected: 'Paris' }, { mode: 'exact', expected: 'Paris', ignoreCase: true, ignoreAccents: false }],
  ['expected', { mode: 'contains', items: ['a', 'b'] }, { mode: 'contains', items: ['a', 'b'], ignoreCase: true }],
  ['expected', { mode: 'regex', pattern: '^\\d+$', flags: 'i' }, { mode: 'regex', pattern: '^\\d+$', flags: 'i' }],
  ['judge', { criteria: 'Exactitude' }, { criteria: 'Exactitude' }],
  ['manual', {}, {}],
] as const)('%s valide', (m, raw, parsed) => {
  expect(parseScoringConfig(m, raw)).toEqual(parsed);
});

test.each([
  ['expected', { mode: 'regex', pattern: '(', flags: '' }, /Expression régulière invalide/],
  ['expected', { mode: 'regex', pattern: 'a', flags: 'x' }, /validation|drapeau/i],
  ['expected', { mode: 'contains', items: [] }, /validation|items/i],
  ['judge', { criteria: '' }, /validation|criteria/i],
  ['manual', { extra: 1 }, /validation|extra|clé/i],
  ['expected', 'texte', /scoringConfig/],
] as const)('%s refusé', (m, raw, re) => {
  expect(() => parseScoringConfig(m, raw)).toThrow(re);
});
