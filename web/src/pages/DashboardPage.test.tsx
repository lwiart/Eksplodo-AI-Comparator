import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { cloneElement, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import type { Dashboard, Evolution } from '../api/dashboard';
import { AuthContext, type PublicUser, type Role } from '../auth/AuthProvider';
import { DashboardPage } from './DashboardPage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  apiFetch,
}));
vi.mock('../components/catalog/NewModelsCard', () => ({ NewModelsCard: () => <section data-testid="new-models" /> }));
// jsdom ne mesure rien : le conteneur adaptatif reçoit une taille fixe.
vi.mock('recharts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) => cloneElement(children, { width: 600, height: 260 }),
}));

const DASHBOARD: Dashboard = {
  runs: { total: 12, thisMonth: 3 },
  models: { tracked: 18, providers: 7 },
  spend: { monthUsd: 14.2, judgeUsd: 2.1 },
  toScore: { questions: 7, runName: 'Série n°10' },
  recentRuns: [
    { id: 'r1', name: 'Rédaction et logique', suiteName: 'Polyvalence', status: 'completed', modelCount: 6, winner: { name: 'Mistral Large', color: '#7cc4ef' }, costUsd: 3.84, completedAt: '2026-10-15T09:00:00.000Z', createdAt: '2026-10-15T08:00:00.000Z' },
    { id: 'r2', name: 'Réponses clients', suiteName: 'Support', status: 'running', modelCount: 8, winner: { name: 'Claude Opus', color: '#F0631F' }, costUsd: 5.02, completedAt: null, createdAt: '2026-10-14T08:00:00.000Z' },
  ],
  evolutionSuites: [
    { id: 's1', name: 'Polyvalence' },
    { id: 's2', name: 'Support' },
  ],
};

const EVOLUTION_S1: Evolution = {
  suite: { id: 's1', name: 'Polyvalence' },
  runs: [
    { id: 'a', name: 'Série A', completedAt: '2026-09-10T09:00:00.000Z', judgeName: 'Claude Opus' },
    { id: 'b', name: 'Série B', completedAt: '2026-10-15T09:00:00.000Z', judgeName: 'GPT Juge' },
  ],
  series: [
    { modelId: 'm1', name: 'Alpha', color: '#F0631F', points: [6, 8] },
    { modelId: 'm2', name: 'Bravo', color: '#7CC4EF', points: [null, 7] },
    { modelId: 'm3', name: 'Fantôme', color: '#4FD1A5', points: [null, null] },
  ],
};
const EVOLUTION_S2: Evolution = {
  suite: { id: 's2', name: 'Support' },
  runs: [{ id: 'c', name: 'Série C', completedAt: '2026-10-01T09:00:00.000Z', judgeName: null }],
  series: [{ modelId: 'm1', name: 'Alpha', color: '#F0631F', points: [5] }],
};

function serve(dashboard: Dashboard, evolutions: Record<string, Evolution> = { s1: EVOLUTION_S1, s2: EVOLUTION_S2 }) {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/dashboard') return dashboard;
    if (path.startsWith('/api/dashboard/evolution?suiteId=')) {
      const found = evolutions[decodeURIComponent(path.split('=')[1]!)];
      if (found) return found;
    }
    if (path.startsWith('/api/catalog/new')) return { openRouterProviderId: null, models: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }] };
    throw new Error(`Appel inattendu : ${path}`);
  });
}

function renderPage(role: Role) {
  const user: PublicUser = { id: 'u1', email: 'a@example.test', name: 'Laurent Wiart', role };
  return render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AuthContext.Provider value={{ user, loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() }}>
          <DashboardPage />
        </AuthContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
});

test('Admin : quatre cartes dont la dépense avec la part du juge, nouveautés, dernières séries avec vainqueur', async () => {
  serve(DASHBOARD);
  renderPage('admin');

  expect(await screen.findByText('Séries lancées')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Bonjour Laurent, 3 nouveaux modèles à tester');
  expect(screen.getByText('+3 ce mois-ci')).toBeInTheDocument();
  expect(screen.getByText('7 fournisseurs')).toBeInTheDocument();
  expect(screen.getByText(/^Dépense API · /)).toBeInTheDocument();
  expect(screen.getByText('14,20 $')).toBeInTheDocument();
  expect(screen.getByText('dont juge 2,10 $')).toBeInTheDocument();
  const toScore = screen.getByRole('link', { name: 'Série n°10' });
  expect(toScore).toHaveAttribute('href', '/a-noter');
  expect(screen.getByTestId('new-models')).toBeInTheDocument();

  const table = screen.getByRole('table');
  const rows = within(table).getAllByRole('row');
  expect(within(rows[1]!).getByRole('link', { name: 'Rédaction et logique' })).toHaveAttribute('href', '/series/r1');
  expect(rows[1]).toHaveTextContent('Mistral Large');
  expect(rows[1]).not.toHaveTextContent('provisoire');
  expect(rows[1]).toHaveTextContent('3,84 $');
  expect(rows[1]).toHaveTextContent('Terminée');
  // Série en cours : le vainqueur est provisoire.
  expect(rows[2]).toHaveTextContent('Claude Opus');
  expect(rows[2]).toHaveTextContent('provisoire');
});

test('Utilisateur : pas de dépense ni de nouveautés', async () => {
  serve({ ...DASHBOARD, spend: null });
  const { container } = renderPage('user');

  expect(await screen.findByText('Séries lancées')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Bonjour Laurent$/);
  expect(screen.queryByText(/Dépense API/)).toBeNull();
  expect(screen.queryByText(/dont juge/)).toBeNull();
  expect(container.querySelector('[data-testid="new-models"]')).toBeNull();
  expect(apiFetch.mock.calls.map((c) => c[0])).not.toContain('/api/catalog/new');
  expect(screen.getByText('Rédaction et logique')).toBeInTheDocument();
});

test('évolution : une courbe par modèle, juge de chaque série dans l’infobulle, changement de suite relu', async () => {
  serve(DASHBOARD);
  renderPage('user');

  const chart = await screen.findByTestId('evolution-chart');
  // Un modèle dont tous les points sont nuls n'est pas tracé.
  await waitFor(() => expect(chart.querySelectorAll('.recharts-line')).toHaveLength(2));
  expect(chart.textContent).not.toContain('Fantôme');

  // Sans point survolé, aucune infobulle ; sur un point, seulement ce modèle, avec la date et le juge de la série.
  fireEvent.mouseMove(chart.querySelector('.recharts-wrapper')!, { clientX: 400, clientY: 100 });
  expect(screen.queryByTestId('evolution-tooltip')).toBeNull();
  const bravo = chart.querySelectorAll('[data-evolution-dot="Bravo"]');
  expect(bravo).toHaveLength(1);
  fireEvent.mouseEnter(bravo[0]!);
  fireEvent.mouseMove(chart.querySelector('.recharts-wrapper')!, { clientX: 400, clientY: 100 });
  const tooltip = await screen.findByTestId('evolution-tooltip');
  expect(tooltip).toHaveTextContent('Série B · 15/10/2026 · juge : GPT Juge');
  expect(tooltip).toHaveTextContent('Bravo');
  expect(tooltip).not.toHaveTextContent('Alpha');
  // Au survol, recharts redessine le point (point actif) : on quitte les points présents à cet instant.
  for (const dot of chart.querySelectorAll('[data-evolution-dot="Bravo"]')) fireEvent.mouseLeave(dot);
  await waitFor(() => expect(screen.queryByTestId('evolution-tooltip')).toBeNull());

  fireEvent.change(screen.getByLabelText('Suite affichée'), { target: { value: 's2' } });
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/dashboard/evolution?suiteId=s2'));
  await waitFor(() => expect(screen.getByTestId('evolution-chart').querySelectorAll('.recharts-line')).toHaveLength(1));
});

test('aucune série : états vides lisibles', async () => {
  serve({
    runs: { total: 0, thisMonth: 0 },
    models: { tracked: 0, providers: 0 },
    spend: null,
    toScore: { questions: 0, runName: null },
    recentRuns: [],
    evolutionSuites: [],
  });
  renderPage('user');

  expect(await screen.findByText('Aucune série terminée pour cette suite')).toBeInTheDocument();
  expect(screen.getByText('Aucune série pour l’instant.')).toBeInTheDocument();
  expect(screen.getByText('Rien en attente')).toBeInTheDocument();
  expect(screen.queryByLabelText('Suite affichée')).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
});
