import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AuthContext, type PublicUser, type Role } from '../../auth/AuthProvider';
import { NewModelsCard } from './NewModelsCard';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));
vi.mock('./RemoteModelsDialog', () => ({
  RemoteModelsDialog: (p: { providerId: string; providerBaseUrl?: string; initialSearch?: string }) => (
    <div role="dialog" aria-label="Assistant">{`${p.providerId}|${p.providerBaseUrl}|${p.initialSearch}`}</div>
  ),
}));

const NEW = [
  { id: 'n1', openrouterId: 'acme/super-1', name: 'Acme Super 1', inputPricePerM: 1.5, outputPricePerM: 6, supportsVision: true, supportsPdf: false, contextWindow: 128000, firstSeenAt: '2026-10-15T06:00:00.000Z' },
  { id: 'n2', openrouterId: 'acme/mini', name: 'Acme Mini', inputPricePerM: null, outputPricePerM: null, supportsVision: false, supportsPdf: false, contextWindow: null, firstSeenAt: '2026-10-10T06:00:00.000Z' },
];
const OR = { id: 'pOR', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', usable: true };

let orProvider: Record<string, unknown>;
let payload: { models: unknown[]; openRouterProviderId: string | null };
beforeEach(() => {
  orProvider = OR;
  payload = { models: NEW, openRouterProviderId: 'pOR' };
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (path === '/api/catalog/new') return Promise.resolve(payload);
    if (path === '/api/providers') return Promise.resolve({ providers: [orProvider] });
    if (path.endsWith('/dismiss')) return Promise.resolve(undefined);
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});
afterEach(() => vi.clearAllMocks());

function renderCard(role: Role = 'admin') {
  const user: PublicUser = { id: 'u1', email: 'a@example.test', name: 'Laurent', role };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={{ user, loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() }}>
        <NewModelsCard />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

test('Admin : nouveautés avec date, prix et capacités ; « Ignorer » retire la ligne', async () => {
  const user = userEvent.setup();
  renderCard();
  expect(await screen.findByText('Acme Super 1')).toBeInTheDocument();
  expect(screen.getByText('acme/super-1')).toBeInTheDocument();
  expect(screen.getByText('1,5 / 6 $')).toBeInTheDocument();
  expect(screen.getByText('Vision')).toBeInTheDocument();
  expect(screen.getByText('15/10/2026')).toBeInTheDocument();
  expect(screen.getByText('Prix inconnu')).toBeInTheDocument();
  payload = { models: [NEW[1]!], openRouterProviderId: 'pOR' };
  await user.click(screen.getAllByRole('button', { name: /^Ignorer/ })[0]!);
  expect(apiFetch).toHaveBeenCalledWith('/api/catalog/n1/dismiss', { method: 'POST' });
  await vi.waitFor(() => expect(screen.queryByText('Acme Super 1')).not.toBeInTheDocument());
  expect(screen.getByText('Acme Mini')).toBeInTheDocument();
});

test('« Ajouter » ouvre l’assistant sur le fournisseur OpenRouter, filtré sur le modèle', async () => {
  const user = userEvent.setup();
  renderCard();
  await screen.findByText('Acme Super 1');
  await user.click(screen.getAllByRole('button', { name: /^Ajouter/ })[0]!);
  expect(await screen.findByRole('dialog', { name: 'Assistant' })).toHaveTextContent('pOR|https://openrouter.ai/api/v1|acme/super-1');
});

test('sans fournisseur OpenRouter actif : « Ajouter » désactivé avec explication', async () => {
  payload = { models: NEW, openRouterProviderId: null };
  renderCard();
  await screen.findByText('Acme Super 1');
  for (const b of screen.getAllByRole('button', { name: /^Ajouter/ })) expect(b).toBeDisabled();
  expect(screen.getByText(/Activez le fournisseur OpenRouter/)).toBeInTheDocument();
});

test('fournisseur OpenRouter sans clé utilisable : « Ajouter » désactivé avec explication', async () => {
  orProvider = { ...OR, usable: false, keyState: 'missing' };
  renderCard();
  await screen.findByText('Acme Super 1');
  await vi.waitFor(() => expect(screen.getByText(/manquante ou illisible/)).toBeInTheDocument());
  for (const b of screen.getAllByRole('button', { name: /^Ajouter/ })) expect(b).toBeDisabled();
});

test('« Ignorer » en échec : l’erreur s’affiche dans la ligne', async () => {
  const user = userEvent.setup();
  const base = apiFetch.getMockImplementation()!;
  apiFetch.mockImplementation((path: string) =>
    path.endsWith('/dismiss') ? Promise.reject(Object.assign(new Error('x'), { code: 'network' })) : base(path),
  );
  renderCard();
  await screen.findByText('Acme Super 1');
  await user.click(screen.getAllByRole('button', { name: /^Ignorer/ })[0]!);
  expect(await screen.findByRole('alert')).toHaveTextContent(/serveur ne répond pas/);
});

test('Utilisateur : carte absente (aucun appel à /api/catalog/new)', () => {
  renderCard('user');
  expect(screen.queryByText(/OpenRouter/)).not.toBeInTheDocument();
  expect(apiFetch).not.toHaveBeenCalled();
});

test('aucune nouveauté : « Rien de nouveau sur OpenRouter ces 30 derniers jours »', async () => {
  payload = { models: [], openRouterProviderId: 'pOR' };
  renderCard();
  expect(await screen.findByText('Rien de nouveau sur OpenRouter ces 30 derniers jours')).toBeInTheDocument();
});
