import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { Evolution } from '../../api/dashboard';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));
import EvolutionLines, { evolutionRows } from './EvolutionLines';
import { QualityEvolutionChart } from './QualityEvolutionChart';
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

test('légende (pastilles et noms) et alternative textuelle avec nom, date et juge de chaque série', () => {
  render(<EvolutionLines evolution={EVOLUTION} />);
  const legend = screen.getByRole('list', { name: 'Légende' });
  expect(legend.textContent).toBe('AlphaBravo');
  const alt = screen.getByRole('list', { name: 'Séries comparées' });
  expect(Array.from(alt.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
    '#1 : Série A, 10/09/2026, juge : Claude Opus',
    '#2 : Série B, 15/10/2026, juge : aucun',
  ]);
});

function renderChart(evolution: Evolution) {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(evolution);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <QualityEvolutionChart suites={[{ id: 's1', name: 'Polyvalence' }]} />
    </QueryClientProvider>,
  );
}

test('aucune série terminée : message dédié', async () => {
  renderChart({ ...EVOLUTION, runs: [], series: [] });
  expect(await screen.findByText('Aucune série terminée pour cette suite')).toBeInTheDocument();
});

test('séries terminées sans note de qualité : message distinct', async () => {
  renderChart({ ...EVOLUTION, series: [{ modelId: 'x', name: 'Alpha', color: '#F0631F', points: [null, null] }] });
  expect(await screen.findByText('Aucune note de qualité pour ces séries')).toBeInTheDocument();
  expect(screen.queryByText('Aucune série terminée pour cette suite')).toBeNull();
});
