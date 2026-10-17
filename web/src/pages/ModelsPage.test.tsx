import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AuthContext, type PublicUser, type Role } from '../auth/AuthProvider';
import { ModelsPage } from './ModelsPage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  apiFetch,
}));

const base = { providerType: 'anthropic', priceSource: 'manual', enabled: true, createdAt: '2026-10-01T08:00:00.000Z' };
const MODELS = [
  { ...base, id: 'm1', providerId: 'p1', providerName: 'Anthropic', apiModelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', color: '#F0631F', inputPricePerM: 4, outputPricePerM: 20, supportsVision: true, supportsPdf: true, contextWindow: 200000, available: true },
  { ...base, id: 'm2', providerId: 'p2', providerName: 'Mistral', providerType: 'openai_compatible', apiModelId: 'mistral-large', displayName: 'Mistral Large', color: '#3FA2E0', inputPricePerM: 2, outputPricePerM: 6, supportsVision: false, supportsPdf: false, contextWindow: null, available: false },
];
const PROVIDERS = [
  { id: 'p1', name: 'Anthropic', type: 'anthropic', baseUrl: 'https://a.test', maxConcurrency: 2, enabled: true, keyState: 'stored', keyLast4: 'wxyz', usable: true, fake: false, modelCount: 1 },
  { id: 'p2', name: 'Mistral', type: 'openai_compatible', baseUrl: 'https://m.test', maxConcurrency: 2, enabled: true, keyState: 'missing', keyLast4: null, usable: false, fake: false, modelCount: 1 },
];

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (path === '/api/models') return Promise.resolve({ models: MODELS });
    if (path === '/api/providers') return Promise.resolve({ providers: PROVIDERS });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});
afterEach(() => vi.clearAllMocks());

function renderPage(role: Role = 'admin') {
  const user: PublicUser = { id: 'u1', email: 'a@example.test', name: 'Laurent', role };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={{ user, loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() }}>
        <MemoryRouter>
          <ModelsPage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

test('tableau : modèle (pastille de couleur), fournisseur, prix $/M, vision, PDF, contexte, disponibilité', async () => {
  renderPage();
  const row = within((await screen.findByRole('link', { name: 'Claude Opus 5.5' })).closest('tr')!);
  expect(row.getByText('Anthropic')).toBeInTheDocument();
  expect(row.getByText('4 / 20 $')).toBeInTheDocument();
  expect(row.getByLabelText('Vision : oui')).toBeInTheDocument();
  expect(row.getByLabelText('PDF : oui')).toBeInTheDocument();
  expect(row.getByText('200 k')).toBeInTheDocument();
  expect(row.getByText('Disponible')).toBeInTheDocument();
  expect(row.getByTestId('swatch')).toHaveStyle({ backgroundColor: '#F0631F' });
  const other = within(screen.getByRole('link', { name: 'Mistral Large' }).closest('tr')!);
  expect(other.getByLabelText('Vision : non')).toBeInTheDocument();
  expect(other.getByText('Indisponible')).toBeInTheDocument();
});

test('filtres : fournisseur, « disponibles seulement »', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('link', { name: 'Mistral Large' });
  await user.selectOptions(screen.getByLabelText('Fournisseur'), 'p1');
  expect(screen.queryByRole('link', { name: 'Mistral Large' })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Fournisseur'), '');
  await user.click(screen.getByLabelText('Disponibles seulement'));
  expect(screen.queryByRole('link', { name: 'Mistral Large' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Claude Opus 5.5' })).toBeInTheDocument();
});

test('Admin : bouton « Ajouter des modèles »', async () => {
  renderPage('admin');
  expect(await screen.findByRole('button', { name: 'Ajouter des modèles' })).toBeInTheDocument();
});

test('Utilisateur : pas de bouton d’ajout ni d’appel à /api/providers', async () => {
  renderPage('user');
  await screen.findByRole('link', { name: 'Claude Opus 5.5' });
  expect(screen.queryByRole('button', { name: 'Ajouter des modèles' })).not.toBeInTheDocument();
  expect(apiFetch).not.toHaveBeenCalledWith('/api/providers');
});
