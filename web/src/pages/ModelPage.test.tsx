import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, type ReactElement } from 'react';
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

// jsdom ne mesure rien : le conteneur adaptatif reçoit une taille fixe.
vi.mock('recharts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) => cloneElement(children, { width: 500, height: 280 }),
}));

const EMPTY_STATS = { quality: null, medianTtftMs: null, ttftRank: null, medianTokensPerS: null, tpsRank: null, reliability: null, radar: [], history: [] };
const STATS = {
  quality: 81,
  medianTtftMs: 420,
  ttftRank: { rank: 2, of: 6 },
  medianTokensPerS: 131.5,
  tpsRank: { rank: 1, of: 6 },
  reliability: 95,
  radar: [
    { category: 'Rédaction', model: 80, average: 65 },
    { category: 'Logique', model: 70, average: 70 },
    { category: 'Code', model: null, average: 5 },
  ],
  history: [
    { runId: 'r12', runName: 'Rédaction et logique', completedAt: '2026-10-10T10:00:00.000Z', rank: 1, of: 6, quality: 81, global: 83 },
    { runId: 'r10', runName: 'Réponses clients', completedAt: '2026-09-10T10:00:00.000Z', rank: null, of: 8, quality: null, global: null },
  ],
};

let stats: () => Promise<unknown>;
let detail: () => Promise<unknown>;
beforeEach(() => {
  detail = () => Promise.resolve({ model: MODEL });
  stats = () => Promise.resolve({ stats: EMPTY_STATS });
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: unknown }) => {
    if (path === '/api/models/m1' && init?.method === 'PATCH') return Promise.resolve({ model: MODEL });
    if (path === '/api/models/m1/stats') return stats();
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
  await screen.findByRole('heading', { name: 'Radar par catégorie' });
  for (const name of ['Chiffres clés', 'Radar par catégorie', 'Historique des séries']) {
    expect(screen.getByRole('heading', { name })).toBeInTheDocument();
  }
  expect(screen.getAllByText('Aucune série pour l’instant')).toHaveLength(3);
});

test('fiche : chiffres clés avec rangs à la française, radar et historique', async () => {
  stats = () => Promise.resolve({ stats: STATS });
  renderPage('user');
  const figures = within(await screen.findByRole('heading', { name: 'Chiffres clés' }).then((h) => h.closest('div')!));
  expect(await figures.findByText('81 / 100')).toBeInTheDocument();
  expect(figures.getByText('420 ms')).toBeInTheDocument();
  expect(figures.getByText('2ᵉ sur 6')).toBeInTheDocument();
  expect(figures.getByText('131,5 tokens/s')).toBeInTheDocument();
  expect(figures.getByText('1ᵉʳ sur 6')).toBeInTheDocument();
  expect(figures.getByText('95 %')).toBeInTheDocument();
  const radar = await screen.findByTestId('model-radar');
  expect(radar.querySelectorAll('.recharts-radar')).toHaveLength(2);
  expect(radar.textContent).toContain('Rédaction');
  expect(screen.queryByText('Aucune série pour l’instant')).not.toBeInTheDocument();
  const link = screen.getByRole('link', { name: 'Rédaction et logique' });
  expect(link).toHaveAttribute('href', '/series/r12');
  const row = link.closest('tr')!;
  expect(within(row).getByText('1 / 6')).toBeInTheDocument();
  expect(within(row).getByText('83')).toBeInTheDocument();
  expect(within(screen.getByRole('link', { name: 'Réponses clients' }).closest('tr')!).getByText('—', { selector: 'td:nth-child(3)' })).toBeInTheDocument();
});

test('fiche : moins de trois catégories, le radar laisse place à une liste', async () => {
  stats = () => Promise.resolve({ stats: { ...STATS, radar: STATS.radar.slice(0, 2) } });
  renderPage('user');
  expect(await screen.findByRole('columnheader', { name: 'Moyenne' })).toBeInTheDocument();
  expect(screen.queryByTestId('model-radar')).not.toBeInTheDocument();
});

test('fiche : mesures indisponibles, message d’erreur sans bloquer la fiche', async () => {
  stats = () => Promise.reject(new ApiError('internal', 500, 'x'));
  renderPage('user');
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Claude Opus 5.5' })).toBeInTheDocument();
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
