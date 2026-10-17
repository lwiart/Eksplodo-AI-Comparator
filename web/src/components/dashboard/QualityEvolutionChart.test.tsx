import { expect, test } from 'vitest';
import type { Evolution } from '../../api/dashboard';
import { evolutionRows } from './EvolutionLines';
import { plottedSeries } from './evolution-series';

const EVOLUTION: Evolution = {
  suite: { id: 's1', name: 'Polyvalence' },
  runs: [
    { id: 'a', name: 'Série A', completedAt: '2026-09-10T09:00:00.000Z', judgeName: 'Claude Opus' },
    { id: 'b', name: 'Série B', completedAt: '2026-10-15T09:00:00.000Z', judgeName: null },
  ],
  series: [
    { modelId: 'x', name: 'Alpha', color: '#F0631F', points: [6, 8] },
    { modelId: 'y', name: 'Fantôme', color: '#4FD1A5', points: [null, null] },
    { modelId: 'z', name: 'Bravo', color: '#7CC4EF', points: [null, 7] },
  ],
};

test('un modèle dont tous les points sont nuls n’est pas tracé', () => {
  expect(plottedSeries(EVOLUTION.series).map((s) => s.name)).toEqual(['Alpha', 'Bravo']);
});

test('une ligne par série avec date et juge, sans identifiant interne comme clé', () => {
  expect(evolutionRows(EVOLUTION)).toEqual([
    { name: 'Série A', date: '10/09/2026', judge: 'Claude Opus', m0: 6, m1: null },
    { name: 'Série B', date: '15/10/2026', judge: 'aucun', m0: 8, m1: 7 },
  ]);
});
