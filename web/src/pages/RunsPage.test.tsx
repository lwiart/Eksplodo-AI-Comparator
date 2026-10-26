import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import { AuthContext, type PublicUser, type Role } from '../auth/AuthProvider';
import { RunsPage } from './RunsPage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  apiFetch,
}));

const counts = (over: Record<string, number> = {}) => ({ pending: 0, running: 0, done: 0, error: 0, timeout: 0, unsupported: 0, truncated: 0, total: 0, ...over });
const summary = (over: Record<string, unknown>) => ({
  id: 'r1',
  name: 'Série',
  status: 'completed',
  pauseReason: null,
  suiteName: null,
  modelCount: 2,
  models: [
    { id: 'm1', name: 'Claude Opus', color: '#F0631F' },
    { id: 'm2', name: 'Mistral Large', color: '#7cc4ef' },
  ],
  testCount: 3,
  repetitions: 1,
  judgeModelName: null,
  modelsCostUsd: 0,
  judgeCostUsd: 0,
  budgetUsd: null,
  createdAt: '2026-10-15T08:30:00.000Z',
  startedAt: '2026-10-15T08:30:05.000Z',
  completedAt: '2026-10-15T09:10:00.000Z',
  counts: counts({ done: 6, total: 6 }),
  ...over,
});
const RUNS = [
  summary({
    id: 'r2',
    name: 'Polyvalence octobre',
    status: 'running',
    suiteName: 'Polyvalence',
    modelCount: 4,
    repetitions: 2,
    modelsCostUsd: 1.2,
    judgeCostUsd: 0.3,
    completedAt: null,
    counts: counts({ done: 10, running: 2, pending: 12, total: 24 }),
  }),
  summary({ id: 'r1', name: 'Essai à la carte', modelsCostUsd: 0.05 }),
];

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (path === '/api/runs') return Promise.resolve({ runs: RUNS });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});

function renderPage(role: Role) {
  const user: PublicUser = { id: 'u1', email: 'a@example.test', name: 'Laurent', role };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={{ user, loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() }}>
        <MemoryRouter>
          <RunsPage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

test('liste : statut, suite, modèles, coût, dates ; bouton « Lancer une série » pour l’Admin seulement', async () => {
  renderPage('admin');
  const link = await screen.findByRole('link', { name: 'Polyvalence octobre' });
  expect(link).toHaveAttribute('href', '/series/r2');
  const row = within(link.closest('tr')!);
  expect(row.getByText('En cours')).toBeInTheDocument();
  expect(row.getByText('Polyvalence')).toBeInTheDocument();
  expect(row.getByText('4 modèles × 2')).toBeInTheDocument();
  expect(row.getByText('1,50 $')).toBeInTheDocument();
  expect(row.getByText('10 / 24')).toBeInTheDocument();
  expect(row.getByText('15/10/2026')).toBeInTheDocument();

  const other = within(screen.getByRole('link', { name: 'Essai à la carte' }).closest('tr')!);
  expect(other.getByText('Terminée')).toBeInTheDocument();
  expect(other.getByText('Tests à la carte')).toBeInTheDocument();
  expect(other.getByText('0,05 $')).toBeInTheDocument();

  expect(screen.getByRole('link', { name: 'Lancer une série' })).toHaveAttribute('href', '/series/nouvelle');
});

test('infobulles : nombre de tests au survol de la suite, noms des modèles au survol de « Modèles × répétitions »', async () => {
  renderPage('user');
  const row = within((await screen.findByRole('link', { name: 'Essai à la carte' })).closest('tr')!);
  const tipOf = (el: HTMLElement) => document.getElementById(el.getAttribute('aria-describedby')!)!;
  const suite = row.getByText('Tests à la carte');
  fireEvent.mouseEnter(suite);
  expect(tipOf(suite)).toHaveTextContent('3 tests dans cette série');
  expect(tipOf(suite)).toHaveClass('visible');
  fireEvent.mouseLeave(suite);
  expect(tipOf(suite)).toHaveClass('invisible');

  const models = row.getByText('2 modèles × 1');
  fireEvent.mouseEnter(models);
  const tip = tipOf(models);
  expect(tip).toHaveTextContent('Claude Opus');
  expect(tip).toHaveTextContent('Mistral Large');
  expect(tip).toHaveClass('visible');
});

test('Utilisateur : la liste sans bouton de lancement', async () => {
  renderPage('user');
  expect(await screen.findByRole('link', { name: 'Polyvalence octobre' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Lancer une série' })).toBeNull();
});

test('aucune série : invitation à en lancer une', async () => {
  apiFetch.mockImplementation((path: string) => (path === '/api/runs' ? Promise.resolve({ runs: [] }) : Promise.reject(new Error(path))));
  renderPage('admin');
  expect(await screen.findByText(/Aucune série pour l’instant/)).toBeInTheDocument();
});
