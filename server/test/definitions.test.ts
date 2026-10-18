import { expect, test } from 'vitest';
import { DEFINITION_LABELS, DEFINITIONS } from '../src/modules/scoring/definitions.js';
import { DEFINITION_LABELS as WEB_LABELS, DEFINITIONS as WEB_DEFINITIONS } from '../../web/src/components/results/definitions.js';

test('définitions des critères du serveur (export XLSX) identiques à celles du client (bulles d’aide, impression)', () => {
  expect(DEFINITIONS).toEqual(WEB_DEFINITIONS);
  expect(DEFINITION_LABELS).toEqual(WEB_LABELS);
  expect(Object.keys(DEFINITIONS)).toEqual(['global', 'quality', 'speed', 'cost', 'reliability']);
});
