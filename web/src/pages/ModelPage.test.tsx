import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { AuthContext, type PublicUser, type Role } from '../auth/AuthProvider';
import { ModelPage } from './ModelPage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  apiFetch,
}));

const PROVIDER = { id: 'p1', name: 'Anthropic', type: 'anthropic', baseUrl: 'https://a.test', maxConcurrency: 2, enabled: true, keyState: 'stored', keyLast4: 'wxyz', usable: true, fake: false, modelCount: 1 };
const MODEL = {
  id: 'm1', providerId: 'p1', providerName: 'Anthropic', providerType: 'anthropic', apiModelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5',
  color: '#F0631F', inputPricePerM: 4, outputPricePerM: 20, priceSource: 'openrouter', supportsVision: true, supportsPdf: false,
  contextWindow: 200000, enabled: true, available: true, createdAt: '2026-10-01T08:00:00.000Z', provider: PROVIDER,
};

let detail: () => Promise<unknown>;
beforeEach(() => {
  detail = () => Promise.resolve({ model: MODEL });
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: unknown }) => {
    if (path === '/api/models/m1' && init?.method === 'PATCH') return Promise.resolve({ model: MODEL });
    if (path === '/api/models/m1') return detail();
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});
afterEach(() => vi.clearAllMocks());

function renderPage(role: Role = 'admin') {
  const user: PublicUser = { id: 'u1', email: 'a@example.test', name: 'Laurent', role };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={{ user, loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() }}>
        <MemoryRouter initialEntries={['/modeles/m1']}>
          <Routes>
            <Route path="/modeles/:id" element={<ModelPage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

test('fiche : fournisseur, identifiant API, prix, capacités, état de la clé sans valeur', async () => {
  renderPage('user');
  expect(await screen.findByText('claude-opus-5-5')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Claude Opus 5.5' })).toBeInTheDocument();
  expect(screen.getAllByText('Anthropic').length).toBeGreaterThan(0);
  expect(screen.getByText('4 $')).toBeInTheDocument();
  expect(screen.getByText('20 $')).toBeInTheDocument();
  expect(screen.getByText('OpenRouter')).toBeInTheDocument();
  expect(screen.getByText('200 000 tokens')).toBeInTheDocument();
  expect(screen.getByText('Clé enregistrée')).toBeInTheDocument();
  expect(screen.queryByText(/wxyz/)).not.toBeInTheDocument();
});

test('Admin : …last4 visible', async () => {
  renderPage('admin');
  expect(await screen.findByText('…wxyz')).toBeInTheDocument();
});

test('sections de mesures vides : « Aucune série pour l’instant »', async () => {
  renderPage('user');
  await screen.findByText('claude-opus-5-5');
  for (const name of ['Chiffres clés', 'Radar par catégorie', 'Historique des séries']) {
    expect(screen.getByRole('heading', { name })).toBeInTheDocument();
  }
  expect(screen.getAllByText('Aucune série pour l’instant')).toHaveLength(3);
});

test('Admin : modifier prix, couleur et activation ; Utilisateur : lecture seule', async () => {
  const user = userEvent.setup();
  renderPage('admin');
  await user.click(await screen.findByRole('button', { name: 'Modifier' }));
  const input = screen.getByLabelText('Prix entrée ($/M)');
  await user.clear(input);
  await user.type(input, '5');
  fireEvent.change(screen.getByLabelText('Couleur'), { target: { value: '#112233' } });
  await user.click(screen.getByRole('switch', { name: 'Actif' }));
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  const call = apiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
  expect(call[0]).toBe('/api/models/m1');
  expect(call[1].body).toMatchObject({ inputPricePerM: 5, enabled: false, color: '#112233' });
  expect(call[1].body).not.toHaveProperty('outputPricePerM');
});

test('Enregistrer sans modification : aucune requête, le formulaire se ferme', async () => {
  const user = userEvent.setup();
  renderPage('admin');
  await user.click(await screen.findByRole('button', { name: 'Modifier' }));
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await vi.waitFor(() => expect(screen.queryByRole('heading', { name: 'Modifier le modèle' })).not.toBeInTheDocument());
  expect(apiFetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
});

test('mode faux : « Faux fournisseur » à la place de « Clé manquante »', async () => {
  detail = () => Promise.resolve({ model: { ...MODEL, provider: { ...PROVIDER, keyState: 'missing', keyLast4: null, fake: true } } });
  renderPage('user');
  expect(await screen.findByText('Faux fournisseur')).toBeInTheDocument();
  expect(screen.queryByText('Clé manquante')).not.toBeInTheDocument();
});

test('Utilisateur : aucun bouton de modification', async () => {
  renderPage('user');
  await screen.findByText('claude-opus-5-5');
  expect(screen.queryByRole('button', { name: 'Modifier' })).not.toBeInTheDocument();
});

test('modèle absent ou désactivé (404) : « Modèle introuvable »', async () => {
  detail = () => Promise.reject(new ApiError('not_found', 404, 'Modèle introuvable'));
  renderPage('user');
  expect(await screen.findByText('Modèle introuvable')).toBeInTheDocument();
});
