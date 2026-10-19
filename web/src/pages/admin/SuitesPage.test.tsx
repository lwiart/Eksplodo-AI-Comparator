import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import { SuitesPage } from './SuitesPage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));

const base = {
  systemPrompt: null,
  userPrompt: 'x',
  temperature: 0.2,
  maxTokens: 1000,
  scoringMethod: 'manual',
  scoringConfig: {},
  archivedAt: null,
  attachments: [],
  usedInRuns: 0,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  category: 'Rédaction',
  tags: [],
};
const TESTS = [
  { ...base, id: 't1', name: 'Résumer un CCTP' },
  { ...base, id: 't2', name: 'Extraire les dates' },
  { ...base, id: 't3', name: 'Traduire' },
];
const st = (id: string, name: string, archived = false) => ({
  id,
  name,
  category: 'Rédaction',
  scoringMethod: 'manual',
  archived,
  attachmentCount: 0,
});
const SUITE = {
  id: 's1',
  name: 'Marchés publics',
  description: null,
  tests: [st('t1', 'Résumer un CCTP'), st('t2', 'Extraire les dates'), st('t9', 'Ancien test', true)],
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: unknown }) => {
    if (path === '/api/tests') return Promise.resolve({ tests: TESTS });
    if (path === '/api/suites' && !init?.method) return Promise.resolve({ suites: [SUITE] });
    if (path === '/api/suites' && init?.method === 'POST') return Promise.resolve({ suite: { ...SUITE, id: 's2' } });
    if (path === '/api/suites/s1' && init?.method === 'PUT') return Promise.resolve({ suite: SUITE });
    if (path === '/api/suites/s1/duplicate') return Promise.resolve({ suite: { ...SUITE, id: 's3' } });
    if (path === '/api/suites/s1' && init?.method === 'DELETE') return Promise.resolve({ outcome: 'deleted' });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SuitesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const call = (path: string, method: string) => apiFetch.mock.calls.find((c) => c[0] === path && c[1]?.method === method);
const order = () => screen.getAllByTestId('suite-test').map((li) => li.getAttribute('data-test-id'));

test('créer une suite en choisissant des tests', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Nouvelle suite' }));
  await user.type(screen.getByLabelText('Nom'), 'Ma suite');
  await user.click(await screen.findByRole('button', { name: 'Ajouter Traduire' }));
  await user.click(screen.getByRole('button', { name: 'Ajouter Résumer un CCTP' }));
  expect(screen.queryByRole('button', { name: 'Ajouter Traduire' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(call('/api/suites', 'POST')).toBeDefined());
  expect(call('/api/suites', 'POST')![1].body).toEqual({ name: 'Ma suite', description: null, testIds: ['t3', 't1'] });
});

test('réordonner au clavier (boutons Monter / Descendre) puis enregistrer : testIds dans le nouvel ordre', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Modifier Marchés publics' }));
  expect(order()).toEqual(['t1', 't2', 't9']);
  await user.click(screen.getByRole('button', { name: 'Descendre Résumer un CCTP' }));
  expect(order()).toEqual(['t2', 't1', 't9']);
  await user.click(screen.getByRole('button', { name: 'Monter Ancien test' }));
  expect(order()).toEqual(['t2', 't9', 't1']);
  expect(screen.getByRole('button', { name: 'Monter Extraire les dates' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(call('/api/suites/s1', 'PUT')).toBeDefined());
  expect(call('/api/suites/s1', 'PUT')![1].body.testIds).toEqual(['t2', 't9', 't1']);
});

test('glisser-déposer réordonne la liste', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Modifier Marchés publics' }));
  const items = screen.getAllByTestId('suite-test');
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
  fireEvent.dragStart(items[0]!, { dataTransfer });
  fireEvent.dragOver(items[2]!, { dataTransfer });
  fireEvent.drop(items[2]!, { dataTransfer });
  expect(order()).toEqual(['t2', 't9', 't1']);
});

test('dupliquer et supprimer', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Dupliquer Marchés publics' }));
  await waitFor(() => expect(call('/api/suites/s1/duplicate', 'POST')).toBeDefined());
  expect(await screen.findByText('Suite dupliquée')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Supprimer Marchés publics' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Confirmer la suppression' }));
  await waitFor(() => expect(call('/api/suites/s1', 'DELETE')).toBeDefined());
  expect(await screen.findByText('Suite supprimée')).toBeInTheDocument();
});

test('test archivé signalé dans la suite, absent du sélecteur d’ajout', async () => {
  const user = userEvent.setup();
  renderPage();
  expect(await screen.findByText('3 tests dont 1 archivé')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Modifier Marchés publics' }));
  const row = screen.getAllByTestId('suite-test')[2]!;
  expect(within(row).getByText('Archivé')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Ajouter Traduire' })).toBeInTheDocument();
});

test('nom déjà pris : message dédié', async () => {
  const user = userEvent.setup();
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/api/tests') return Promise.resolve({ tests: TESTS });
    if (init?.method === 'POST') return Promise.reject(Object.assign(new Error('x'), { code: 'suite_name_taken' }));
    return Promise.resolve({ suites: [] });
  });
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Nouvelle suite' }));
  await user.type(screen.getByLabelText('Nom'), 'Doublon');
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(await screen.findByText('Une suite porte déjà ce nom.')).toBeInTheDocument();
});

test('édition : fil d’Ariane « Suites / nom », « Suites » referme l’éditeur et ramène à la liste', async () => {
  const user = userEvent.setup();
  renderPage();
  expect(screen.queryByRole('navigation', { name: 'Fil d’Ariane' })).toBeNull();
  await user.click(await screen.findByRole('button', { name: 'Modifier Marchés publics' }));
  const crumbs = screen.getByRole('navigation', { name: 'Fil d’Ariane' });
  expect(crumbs).toHaveTextContent('Suites / Marchés publics');
  // Édition : seule la suite éditée, ni la liste ni « Nouvelle suite ».
  expect(screen.getByRole('heading', { level: 1, name: 'Marchés publics' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Modifier Marchés publics' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Nouvelle suite' })).toBeNull();
  await user.click(within(crumbs).getByRole('button', { name: 'Suites' }));
  expect(screen.queryByRole('navigation', { name: 'Fil d’Ariane' })).toBeNull();
  expect(screen.queryByLabelText('Nom')).toBeNull();
  expect(screen.getByRole('button', { name: 'Modifier Marchés publics' })).toBeInTheDocument();
  // Nouvelle suite : libellé dédié.
  await user.click(screen.getByRole('button', { name: 'Nouvelle suite' }));
  expect(screen.getByRole('navigation', { name: 'Fil d’Ariane' })).toHaveTextContent('Suites / Nouvelle suite');
});
