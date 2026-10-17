import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { ToScorePage } from './ToScorePage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  apiFetch,
}));

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ToScorePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
});

test('liste « À noter » : questions regroupées par série, avancement et lien vers la notation', async () => {
  apiFetch.mockResolvedValue({
    items: [
      { runTestId: 'q1', runId: 'r1', runName: 'Série clients', testName: 'Réponse empathique', answers: 3, scoredByMe: 1 },
      { runTestId: 'q2', runId: 'r1', runName: 'Série clients', testName: 'Résumé', answers: 3, scoredByMe: 3 },
    ],
    count: 2,
  });
  renderPage();
  const link = await screen.findByRole('link', { name: /Réponse empathique/ });
  expect(link).toHaveAttribute('href', '/a-noter/q1');
  expect(link).toHaveTextContent('1 / 3 notées');
  expect(screen.getByRole('link', { name: 'Série clients' })).toHaveAttribute('href', '/series/r1');
  expect(screen.queryByText('Résumé')).toBeNull();
});

test('liste vide : message d’invitation', async () => {
  apiFetch.mockResolvedValue({ items: [], count: 0 });
  renderPage();
  expect(await screen.findByText(/Rien à noter/)).toBeInTheDocument();
});

test('erreur de chargement : message en français', async () => {
  apiFetch.mockRejectedValue(new ApiError('network', 0, 'x'));
  renderPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('Le serveur ne répond pas');
});
