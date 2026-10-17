import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { ProvidersPage } from './ProvidersPage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));

const base = { type: 'openai_compatible', baseUrl: 'https://x.test/v1', maxConcurrency: 2, enabled: true, usable: false, fake: false, modelCount: 0, keyLast4: null };
const PROVIDERS = [
  { ...base, id: 'p1', name: 'Anthropic', type: 'anthropic', keyState: 'stored', keyLast4: 'wxyz', usable: true, modelCount: 3 },
  { ...base, id: 'p2', name: 'OpenAI', keyState: 'missing' },
  { ...base, id: 'p3', name: 'Mistral', keyState: 'unreadable', keyLast4: 'abcd' },
];

let providers: unknown[] = PROVIDERS;
beforeEach(() => {
  providers = PROVIDERS;
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (path === '/api/providers') return Promise.resolve({ providers });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});
afterEach(() => vi.clearAllMocks());

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProvidersPage />
    </QueryClientProvider>,
  );
}
const card = (name: string) => within(screen.getByRole('region', { name }));

test('pastilles « Clé enregistrée …wxyz », « Clé manquante », « Clé illisible »', async () => {
  renderPage();
  expect(await screen.findByText('…wxyz')).toBeInTheDocument();
  expect(screen.getAllByText('Clé manquante').length).toBeGreaterThan(0);
  expect(screen.getByText('Clé illisible')).toBeInTheDocument();
  expect(screen.getByText(/chiffrées dans la base/)).toBeInTheDocument();
});

test('mode faux : pastille « Faux fournisseur »', async () => {
  providers = [{ ...PROVIDERS[1], fake: true, usable: true }];
  renderPage();
  expect(await screen.findByText('Faux fournisseur')).toBeInTheDocument();
});

test('sans clé utilisable : « Interroger /models » et « Tester la connexion » désactivés, bouton « Saisir la clé »', async () => {
  renderPage();
  await screen.findByRole('region', { name: 'OpenAI' });
  expect(card('OpenAI').getByRole('button', { name: 'Interroger /models' })).toBeDisabled();
  expect(card('OpenAI').getByRole('button', { name: 'Tester la connexion' })).toBeDisabled();
  expect(card('OpenAI').getByRole('button', { name: 'Saisir la clé' })).toBeEnabled();
  expect(card('Anthropic').getByRole('button', { name: 'Remplacer la clé' })).toBeEnabled();
  expect(card('Anthropic').getByRole('button', { name: 'Tester la connexion' })).toBeEnabled();
});

test('Tester la connexion : « Connexion réussie · 42 modèles » ou le message d’erreur', async () => {
  const user = userEvent.setup();
  const results = [
    { ok: true, modelCount: 42, latencyMs: 120 },
    { ok: false, code: 'auth_invalid', message: 'Clé refusée par le fournisseur' },
    { ok: false, code: 'bad_request', message: 'Requête refusée par le fournisseur', detail: 'Your credit balance is too low' },
  ];
  apiFetch.mockImplementation((path: string) => {
    if (path === '/api/providers') return Promise.resolve({ providers });
    if (path === '/api/providers/p1/test') return Promise.resolve(results.shift());
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
  renderPage();
  await screen.findByRole('region', { name: 'Anthropic' });
  await user.click(card('Anthropic').getByRole('button', { name: 'Tester la connexion' }));
  expect(await card('Anthropic').findByText('Connexion réussie · 42 modèles')).toBeInTheDocument();
  await user.click(card('Anthropic').getByRole('button', { name: 'Tester la connexion' }));
  expect(await card('Anthropic').findByText('Clé refusée par le fournisseur')).toBeInTheDocument();
  expect(card('Anthropic').queryByText(/Message du fournisseur/)).toBeNull();
  await user.click(card('Anthropic').getByRole('button', { name: 'Tester la connexion' }));
  expect(await card('Anthropic').findByText('Message du fournisseur : Your credit balance is too low')).toBeInTheDocument();
});

test('un échec de l’API est signalé', async () => {
  apiFetch.mockImplementation(() => Promise.reject(new ApiError('forbidden', 403, 'x')));
  renderPage();
  expect(await screen.findByRole('alert')).toHaveTextContent(/droits/);
});
