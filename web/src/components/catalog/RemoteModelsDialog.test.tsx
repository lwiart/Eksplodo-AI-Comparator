import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { RemoteModelsDialog } from './RemoteModelsDialog';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));

const REMOTE = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 200000, inputPricePerM: 2, outputPricePerM: 10, supportsVision: true, supportsPdf: true, alreadyAdded: false },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200000, inputPricePerM: 3, outputPricePerM: 15, supportsVision: true, supportsPdf: false, alreadyAdded: false },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 200000, inputPricePerM: 4, outputPricePerM: 20, supportsVision: true, supportsPdf: true, alreadyAdded: true },
  { id: 'gpt-x', name: 'GPT X', contextWindow: null, inputPricePerM: null, outputPricePerM: null, supportsVision: null, supportsPdf: null, alreadyAdded: false },
];

let remote: () => Promise<unknown>;
beforeEach(() => {
  apiFetch.mockReset();
  remote = () => Promise.resolve({ models: REMOTE });
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/api/providers/p1/remote-models') return remote();
    if (path === '/api/models' && init?.method === 'POST') return Promise.resolve({ model: {} });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});
afterEach(() => vi.clearAllMocks());

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RemoteModelsDialog providerId="p1" open onOpenChange={() => undefined} />
    </QueryClientProvider>,
  );
}
const posts = () =>
  apiFetch.mock.calls.filter(([p, i]) => p === '/api/models' && (i as { method?: string } | undefined)?.method === 'POST') as [
    string,
    { body: Record<string, unknown> },
  ][];

test('filtre, prix préremplis, modèle déjà ajouté grisé', async () => {
  const user = userEvent.setup();
  renderDialog();
  await screen.findByText('GPT X');
  await user.type(screen.getByRole('searchbox'), 'sonnet');
  expect(screen.queryByText('GPT X')).toBeNull();
  expect(screen.getByText('Claude Sonnet 5.5')).toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: /Claude Sonnet 5\.5/ }));
  expect(screen.getByDisplayValue('2')).toBeInTheDocument();
  expect(screen.getByDisplayValue('10')).toBeInTheDocument();
  await user.clear(screen.getByRole('searchbox'));
  await user.type(screen.getByRole('searchbox'), 'opus');
  expect(screen.getByText('déjà ajouté')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /Claude Opus 5\.5/ })).toBeDisabled();
});

test('« Ajouter 2 modèles » envoie deux POST et signale l’échec du second', async () => {
  const user = userEvent.setup();
  let n = 0;
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/api/providers/p1/remote-models') return Promise.resolve({ models: REMOTE });
    if (path === '/api/models' && init?.method === 'POST') {
      return ++n === 1 ? Promise.resolve({ model: {} }) : Promise.reject(new ApiError('model_exists', 409, 'Ce modèle existe déjà'));
    }
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
  renderDialog();
  await user.click(await screen.findByRole('checkbox', { name: /Claude Sonnet 5\.5/ }));
  await user.click(screen.getByRole('checkbox', { name: /Claude Sonnet 4/ }));
  await user.click(screen.getByRole('button', { name: 'Ajouter 2 modèles' }));
  expect(await screen.findByText(/déjà dans le catalogue/)).toBeInTheDocument();
  expect(posts()).toHaveLength(2);
  expect(posts()[0]![1].body).toMatchObject({
    providerId: 'p1',
    apiModelId: 'claude-sonnet-5-5',
    displayName: 'Claude Sonnet 5.5',
    inputPricePerM: 2,
    outputPricePerM: 10,
    supportsVision: true,
    supportsPdf: true,
    contextWindow: 200000,
  });
  // Le premier est ajouté et sort de la sélection ; seul le second reste, avec son erreur.
  expect(screen.getByRole('button', { name: 'Ajouter 1 modèle' })).toBeInTheDocument();
});

test('/models en échec : message du fournisseur et « Ajouter un modèle à la main »', async () => {
  const user = userEvent.setup();
  remote = () => Promise.reject(new ApiError('provider_error', 502, 'Le fournisseur répond 500'));
  renderDialog();
  expect(await screen.findByRole('alert')).toHaveTextContent('Le fournisseur répond 500');
  await user.click(screen.getByRole('button', { name: 'Ajouter un modèle à la main' }));
  await user.type(screen.getByLabelText('Identifiant API'), 'mon-modele');
  await user.type(screen.getByLabelText('Nom affiché'), 'Mon modèle');
  await user.click(screen.getByRole('button', { name: 'Ajouter 1 modèle' }));
  await vi.waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]![1].body).toMatchObject({ providerId: 'p1', apiModelId: 'mon-modele', displayName: 'Mon modèle' });
});
