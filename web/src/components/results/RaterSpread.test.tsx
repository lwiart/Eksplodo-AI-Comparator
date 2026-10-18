import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { RaterSpread } from './RaterSpread';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api/client')>()), apiFetch }));

const item = (over: Record<string, unknown>) => ({
  resultId: 'a1',
  runTestId: 'rt1',
  testName: 'Résumer',
  modelName: 'Claude Opus',
  raters: 2,
  mean: 75,
  stdDev: 25,
  scores: [
    { userName: 'Laurent', score: 50, comment: 'Trop long' },
    { userName: 'Camille', score: 100, comment: null },
  ],
  ...over,
});

beforeEach(() => {
  apiFetch.mockReset();
});

function renderSpread(items: unknown[], runTestId = 'rt1') {
  apiFetch.mockResolvedValue({ items });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RaterSpread runId="r1" runTestId={runTestId} />
    </QueryClientProvider>,
  );
}

test('écarts entre évaluateurs : moyenne, écart-type et détail des notes, du plus divisé au plus consensuel', async () => {
  renderSpread([
    item({
      resultId: 'b1',
      modelName: 'GPT Test',
      mean: 65,
      stdDev: 5,
      scores: [
        { userName: 'Laurent', score: 60, comment: null },
        { userName: 'Camille', score: 70, comment: null },
      ],
    }),
    item({}),
    item({ resultId: 'z', runTestId: 'rt2', modelName: 'Autre test' }),
  ]);
  const table = within(await screen.findByRole('table', { name: 'Écarts entre évaluateurs' }));
  expect(table.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['Claude Opus', 'GPT Test']);
  const opus = table.getByRole('rowheader', { name: 'Claude Opus' }).closest('tr')!;
  const cells = [...opus.querySelectorAll('td')].map((c) => c.textContent ?? '');
  expect(cells.slice(0, 3)).toEqual(['2', '75', '25']);
  expect(cells[3]).toContain('Laurent 50 : Trop long');
  expect(cells[3]).toContain('Camille 100');
  expect(apiFetch).toHaveBeenCalledWith('/api/scoring/runs/r1/spread');
});

test('aucune note pour le test choisi', async () => {
  renderSpread([item({ raters: 0, mean: null, stdDev: null, scores: [] })]);
  expect(await screen.findByText('Aucune note manuelle enregistrée pour ce test.')).toBeInTheDocument();
});

test('erreur du serveur affichée', async () => {
  apiFetch.mockImplementation(() => Promise.reject(new ApiError('network', 0, 'x')));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RaterSpread runId="r1" runTestId="rt1" />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('alert')).toBeInTheDocument();
});
