import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import { TestsPage } from './TestsPage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));

const base = {
  systemPrompt: null,
  userPrompt: 'Résume',
  temperature: 0.2,
  maxTokens: 1000,
  scoringMethod: 'manual',
  scoringConfig: {},
  archivedAt: null,
  attachments: [],
  usedInRuns: 0,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
};
const TESTS = [
  { ...base, id: 't1', name: 'Résumer un CCTP', category: 'Rédaction', tags: ['marchés', 'pdf'], scoringMethod: 'judge', scoringConfig: { criteria: 'x' } },
  { ...base, id: 't2', name: 'Extraire les dates', category: 'Extraction', tags: ['dates'], usedInRuns: 2 },
];

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/api/tests/meta') return Promise.resolve({ categories: ['Extraction', 'Rédaction'], tags: ['dates', 'marchés', 'pdf'] });
    if (init?.method === 'DELETE') return Promise.resolve({ outcome: 'deleted' });
    if (path.startsWith('/api/tests')) return Promise.resolve({ tests: TESTS });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TestsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const listPaths = () =>
  apiFetch.mock.calls
    .filter((c) => c[1]?.method === undefined)
    .map((c) => c[0] as string)
    .filter((p) => p.startsWith('/api/tests') && p !== '/api/tests/meta');

test('liste : filtres catégorie, tag, recherche ; « Afficher les archivés »', async () => {
  const user = userEvent.setup();
  renderPage();
  expect(await screen.findByText('Résumer un CCTP')).toBeInTheDocument();
  expect(screen.getByText('Extraire les dates')).toBeInTheDocument();
  expect(listPaths().at(-1)).toBe('/api/tests');

  await user.selectOptions(await screen.findByRole('combobox', { name: 'Catégorie' }), 'Rédaction');
  await waitFor(() => expect(listPaths().at(-1)).toBe('/api/tests?category=R%C3%A9daction'));

  await user.selectOptions(screen.getByRole('combobox', { name: 'Tag' }), 'pdf');
  await waitFor(() => expect(listPaths().at(-1)).toContain('tag=pdf'));

  await user.type(screen.getByRole('searchbox', { name: 'Recherche' }), 'cctp');
  await waitFor(() => expect(listPaths().at(-1)).toContain('q=cctp'));

  await user.click(screen.getByLabelText('Afficher les archivés'));
  await waitFor(() => expect(listPaths().at(-1)).toContain('archived=true'));
});

test('supprimer un test utilisé → message « Test archivé (utilisé par une série) »', async () => {
  const user = userEvent.setup();
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/api/tests/meta') return Promise.resolve({ categories: [], tags: [] });
    if (init?.method === 'DELETE') return Promise.resolve({ outcome: 'archived' });
    return Promise.resolve({ tests: TESTS });
  });
  renderPage();
  await screen.findByText('Extraire les dates');
  await user.click(screen.getByRole('button', { name: 'Supprimer Extraire les dates' }));
  await user.click(screen.getByRole('button', { name: 'Confirmer la suppression' }));
  expect(await screen.findByText('Test archivé (utilisé par une série)')).toBeInTheDocument();
  expect(apiFetch).toHaveBeenCalledWith('/api/tests/t2', { method: 'DELETE' });
});

test('supprimer un test jamais utilisé → « Test supprimé »', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Résumer un CCTP');
  await user.click(screen.getByRole('button', { name: 'Supprimer Résumer un CCTP' }));
  await user.click(screen.getByRole('button', { name: 'Confirmer la suppression' }));
  expect(await screen.findByText('Test supprimé')).toBeInTheDocument();
});

test('archivés : bouton « Restaurer »', async () => {
  const user = userEvent.setup();
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/api/tests/meta') return Promise.resolve({ categories: [], tags: [] });
    if (init?.method === 'POST') return Promise.resolve({ test: { ...TESTS[1], archivedAt: null } });
    return Promise.resolve({ tests: [{ ...TESTS[1], archivedAt: '2026-10-05T00:00:00.000Z' }] });
  });
  renderPage();
  await screen.findByText('Extraire les dates');
  await user.click(screen.getByLabelText('Afficher les archivés'));
  await user.click(await screen.findByRole('button', { name: 'Restaurer Extraire les dates' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/tests/t2/restore', { method: 'POST' }));
});

test('nombre de tests : « 2 tests » sans filtre, « N tests sur 2 » avec un filtre', async () => {
  const user = userEvent.setup();
  apiFetch.mockImplementation((path: string) => {
    if (path === '/api/tests/meta') return Promise.resolve({ categories: ['Extraction', 'Rédaction'], tags: ['dates', 'marchés', 'pdf'] });
    if (path.includes('category=')) return Promise.resolve({ tests: [TESTS[0]] });
    if (path.startsWith('/api/tests')) return Promise.resolve({ tests: TESTS });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
  renderPage();
  await screen.findByText('Résumer un CCTP');
  expect(screen.getByRole('status')).toHaveTextContent('2 tests');
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Catégorie' }), 'Rédaction');
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 test sur 2'));
});
