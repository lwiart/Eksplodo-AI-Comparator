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

test('Admin : « Vérifier les capacités » interroge les modèles disponibles affichés et enregistre les cases qui changent', async () => {
  const user = userEvent.setup();
  const deepseek = { ...MODELS[0]!, id: 'm3', providerId: 'p1', apiModelId: 'deepseek-flash', displayName: 'DeepSeek Flash', supportsVision: true, supportsPdf: true };
  const accepted = { vision: { supported: true, message: 'Image acceptée par le modèle.' }, pdf: { supported: true, message: 'PDF accepté par le modèle.' } };
  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: { apiModelId?: string } }) => {
    if (path === '/api/models') return Promise.resolve({ models: [...MODELS, deepseek] });
    if (path === '/api/providers') return Promise.resolve({ providers: PROVIDERS });
    if (path === '/api/providers/p1/check-capabilities') {
      if (init?.body?.apiModelId === 'deepseek-flash')
        return Promise.resolve({ capabilities: { ...accepted, pdf: { supported: false, message: 'PDF refusé : file must have a file_id or file_data' } } });
      return Promise.resolve({ capabilities: accepted });
    }
    if (path === '/api/models/m3' && init?.method === 'PATCH') return Promise.resolve({ model: { ...deepseek, supportsPdf: false } });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
  renderPage('admin');
  await screen.findByRole('link', { name: 'DeepSeek Flash' });
  expect(screen.getByRole('button', { name: 'Aide : Vérifier les capacités' })).toHaveAccessibleDescription(/trois très petits appels réels/);
  await user.click(screen.getByRole('button', { name: 'Vérifier les capacités' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Vérifier les capacités des modèles' }));
  // Mistral Large (indisponible) n'est pas proposé.
  expect(dialog.queryByText('Mistral Large')).toBeNull();
  expect(dialog.getByText(/^2 modèles disponibles/)).toBeInTheDocument();
  await user.click(dialog.getByRole('button', { name: 'Lancer la vérification' }));
  expect(await dialog.findByRole('status')).toHaveTextContent('2 vérifiés : 1 mis à jour.');

  const checks = apiFetch.mock.calls.filter((c) => String(c[0]).endsWith('/check-capabilities')).map((c) => c[1].body.apiModelId);
  expect(checks.sort()).toEqual(['claude-opus-5-5', 'deepseek-flash']);
  const patches = apiFetch.mock.calls.filter((c) => c[1]?.method === 'PATCH');
  expect(patches).toEqual([['/api/models/m3', { method: 'PATCH', body: { supportsVision: true, supportsPdf: false } }]]);
  const row = within(dialog.getByText('DeepSeek Flash').closest('tr')!);
  expect(row.getByLabelText('PDF : non, était oui')).toBeInTheDocument();
  expect(row.getByText('PDF refusé : file must have a file_id or file_data')).toBeInTheDocument();
  expect(within(dialog.getByText('Claude Opus 5.5').closest('tr')!).getByText('Inchangé.')).toBeInTheDocument();
});

test('Utilisateur : pas de bouton « Vérifier les capacités »', async () => {
  renderPage('user');
  await screen.findByRole('link', { name: 'Claude Opus 5.5' });
  expect(screen.queryByRole('button', { name: 'Vérifier les capacités' })).toBeNull();
});

test('Admin : « Mettre à jour les tarifs » propose les tarifs annoncés par le fournisseur et enregistre ceux cochés', async () => {
  const user = userEvent.setup();
  const sonnet = { ...MODELS[0]!, id: 'm3', apiModelId: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', inputPricePerM: 3, outputPricePerM: 15, priceSource: 'openrouter' };
  const remote = (id: string, input: number | null, output: number | null) => ({ id, name: id, contextWindow: null, inputPricePerM: input, outputPricePerM: output, supportsVision: null, supportsPdf: null, alreadyAdded: true });
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/api/models') return Promise.resolve({ models: [...MODELS, sonnet] });
    if (path === '/api/providers') return Promise.resolve({ providers: PROVIDERS });
    if (path === '/api/providers/p1/remote-models') return Promise.resolve({ models: [remote('claude-opus-5-5', 4, 20), remote('claude-sonnet-5-5', 2.5, 12)] });
    if (path === '/api/models/m3' && init?.method === 'PATCH') return Promise.resolve({ model: sonnet });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
  renderPage('admin');
  await screen.findByRole('link', { name: 'Claude Sonnet 5.5' });
  await user.click(screen.getByRole('button', { name: 'Mettre à jour les tarifs' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Mettre à jour les tarifs' }));
  const opus = within((await dialog.findByText('Claude Opus 5.5')).closest('tr')!);
  expect(opus.getByText(/inchangé/)).toBeInTheDocument();
  expect(opus.queryByRole('checkbox')).toBeNull();
  const row = within(dialog.getByText('Claude Sonnet 5.5').closest('tr')!);
  expect(row.getByText('3 / 15 $')).toBeInTheDocument();
  expect(row.getByText('2,5 / 12 $')).toBeInTheDocument();
  expect(row.getByRole('checkbox')).toBeChecked();
  await user.click(dialog.getByRole('button', { name: 'Appliquer 1 changement' }));
  expect(await dialog.findByText('1 tarif mis à jour.')).toBeInTheDocument();
  // Le modèle suivi par la synchronisation OpenRouter le reste ; aucun appel payant (seule la liste des modèles est lue).
  expect(apiFetch.mock.calls.filter((c) => c[1]?.method === 'PATCH')).toEqual([
    ['/api/models/m3', { method: 'PATCH', body: { inputPricePerM: 2.5, outputPricePerM: 12, priceSource: 'openrouter' } }],
  ]);
  expect(apiFetch.mock.calls.some((c) => String(c[0]).includes('check-capabilities'))).toBe(false);
});

test('tri : clic sur « Modèle » (croissant, décroissant, ordre d’origine) et sur « Fournisseur »', async () => {
  const user = userEvent.setup();
  renderPage('admin');
  await screen.findByRole('link', { name: 'Claude Opus 5.5' });
  const names = () => screen.getAllByRole('link').map((a) => a.textContent).filter((t) => t === 'Claude Opus 5.5' || t === 'Mistral Large');
  await user.click(screen.getByRole('button', { name: /^Modèle/ }));
  expect(screen.getByRole('columnheader', { name: /Modèle/ })).toHaveAttribute('aria-sort', 'ascending');
  expect(names()).toEqual(['Claude Opus 5.5', 'Mistral Large']);
  await user.click(screen.getByRole('button', { name: /^Modèle/ }));
  expect(names()).toEqual(['Mistral Large', 'Claude Opus 5.5']);
  await user.click(screen.getByRole('button', { name: /^Modèle/ }));
  expect(screen.getByRole('columnheader', { name: /Modèle/ })).not.toHaveAttribute('aria-sort');
  await user.click(screen.getByRole('button', { name: /^Fournisseur/ }));
  await user.click(screen.getByRole('button', { name: /^Fournisseur/ }));
  expect(screen.getByRole('columnheader', { name: /Fournisseur/ })).toHaveAttribute('aria-sort', 'descending');
  expect(names()).toEqual(['Mistral Large', 'Claude Opus 5.5']);
});
