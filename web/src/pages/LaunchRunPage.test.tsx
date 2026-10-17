import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import { LaunchRunPage } from './LaunchRunPage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  apiFetch,
}));

const baseTest = {
  systemPrompt: null,
  userPrompt: 'x',
  temperature: 0.2,
  maxTokens: 1000,
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
  { ...baseTest, id: 't1', name: 'Résumer', scoringMethod: 'manual' },
  { ...baseTest, id: 't2', name: 'Extraire', scoringMethod: 'manual' },
  { ...baseTest, id: 't3', name: 'Évaluer', scoringMethod: 'judge', scoringConfig: { criteria: 'c' } },
];
const st = (id: string, name: string, scoringMethod = 'manual') => ({
  id,
  name,
  category: 'Rédaction',
  scoringMethod,
  archived: false,
  attachmentCount: 0,
});
const SUITE = { id: 's1', name: 'Polyvalence', description: null, tests: [st('t1', 'Résumer'), st('t2', 'Extraire')], createdAt: '', updatedAt: '' };
const model = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  providerId: 'p1',
  providerName: 'Anthropic',
  providerType: 'anthropic',
  apiModelId: id,
  displayName: name,
  color: '#F0631F',
  inputPricePerM: 3,
  outputPricePerM: 15,
  priceSource: 'manual',
  supportsVision: true,
  supportsPdf: false,
  contextWindow: 200000,
  enabled: true,
  available: true,
  createdAt: '',
  ...over,
});
const MODELS = [model('m1', 'Claude Opus'), model('m2', 'GPT Test', { supportsVision: false, supportsPdf: true }), model('m3', 'Modèle sans clé', { available: false })];
const ESTIMATE = {
  calls: 4,
  unsupported: 1,
  modelsMaxCostUsd: 0.4,
  judgeMaxCostUsd: 0.1,
  maxCostUsd: 0.5,
  durationSeconds: 125,
  perModel: [],
  warnings: ['Le modèle juge fait partie des modèles évalués'],
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/api/suites') return Promise.resolve({ suites: [SUITE] });
    if (path.startsWith('/api/tests')) return Promise.resolve({ tests: TESTS });
    if (path === '/api/models') return Promise.resolve({ models: MODELS });
    if (path === '/api/runs/estimate') return Promise.resolve({ estimate: ESTIMATE });
    if (path === '/api/runs' && init?.method === 'POST') return Promise.resolve({ run: { id: 'r42' } });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/series/nouvelle']}>
        <Routes>
          <Route path="/series/nouvelle" element={<LaunchRunPage />} />
          <Route path="/series/:id" element={<p>Page de la série</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
type User = ReturnType<typeof userEvent.setup>;
const next = (user: User) => user.click(screen.getByRole('button', { name: /^Continuer/ }));
const estimateCalls = () => apiFetch.mock.calls.filter((c) => c[0] === '/api/runs/estimate');

async function toModels(user: User) {
  renderPage();
  await user.click(await screen.findByRole('radio', { name: /Polyvalence/ }));
  await next(user);
}
async function toParams(user: User) {
  await toModels(user);
  await user.click(await screen.findByRole('checkbox', { name: /Claude Opus/ }));
  await next(user);
}

test('étape 1 : une suite ou des tests à la carte', async () => {
  const user = userEvent.setup();
  renderPage();
  expect(await screen.findByRole('radio', { name: /Polyvalence/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Continuer/ })).toBeDisabled();
  await user.click(screen.getByRole('tab', { name: 'Tests à la carte' }));
  await user.click(await screen.findByRole('checkbox', { name: /Évaluer/ }));
  await user.click(screen.getByRole('checkbox', { name: /Résumer/ }));
  expect(screen.getByText('2 tests sélectionnés')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Continuer/ })).toBeEnabled();
});

test('étape 2 : seuls les modèles disponibles sont sélectionnables, capacités affichées', async () => {
  const user = userEvent.setup();
  await toModels(user);
  expect(await screen.findByRole('checkbox', { name: /Modèle sans clé/ })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: /Claude Opus/ })).toBeEnabled();
  expect(screen.getAllByText('Vision').length).toBeGreaterThan(0);
  expect(screen.getAllByText('PDF').length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: /^Continuer/ })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: /Claude Opus/ }));
  expect(screen.getByRole('button', { name: /^Continuer/ })).toBeEnabled();
});

test('étape 3 : répétitions 1 à 5, juge, concurrence, plafond, pondération (somme 100)', async () => {
  const user = userEvent.setup();
  await toParams(user);
  const reps = screen.getByLabelText('Répétitions') as HTMLSelectElement;
  expect([...reps.options].map((o) => o.value)).toEqual(['1', '2', '3', '4', '5']);
  const conc = screen.getByLabelText('Concurrence') as HTMLSelectElement;
  expect(conc.value).toBe('4');
  expect([...conc.options]).toHaveLength(8);
  expect(screen.getByLabelText('Qualité')).toHaveValue(50);
  expect(screen.getByLabelText('Vitesse')).toHaveValue(20);
  expect(screen.getByText('Total : 100')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Qualité'), { target: { value: '60' } });
  expect(screen.getByText(/Total : 110/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Continuer/ })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Qualité'), { target: { value: '50' } });
  expect(screen.getByRole('button', { name: /^Continuer/ })).toBeEnabled();
  expect(screen.getByLabelText('Plafond en $ (facultatif)')).toBeInTheDocument();
  expect(screen.getByLabelText('Modèle juge')).toBeInTheDocument();
});

test('étape 4 : récapitulatif avec appels, non supportés, coût maximal, durée et avertissements', async () => {
  const user = userEvent.setup();
  await toParams(user);
  fireEvent.change(screen.getByLabelText('Plafond en $ (facultatif)'), { target: { value: '2,5' } });
  await next(user);
  expect(await screen.findByText('4 appels dont 1 non supporté')).toBeInTheDocument();
  expect(screen.getByText(/0,50 \$/)).toBeInTheDocument();
  expect(screen.getByText(/2 min 5 s/)).toBeInTheDocument();
  expect(screen.getByText('Le modèle juge fait partie des modèles évalués')).toBeInTheDocument();
  const body = estimateCalls().at(-1)![1].body;
  expect(body).toMatchObject({ suiteId: 's1', testIds: ['t1', 't2'], modelIds: ['m1'], repetitions: 1, concurrency: 4, budgetUsd: 2.5 });
  expect(body.weights).toEqual({ quality: 50, speed: 20, cost: 20, reliability: 10 });
});

test('« Lancer » crée la série et ouvre sa page', async () => {
  const user = userEvent.setup();
  await toParams(user);
  await next(user);
  const launch = screen.getByRole('button', { name: 'Lancer la série' });
  expect(launch).toBeDisabled();
  await waitFor(() => expect(launch).toBeEnabled());
  await user.click(launch);
  expect(await screen.findByText('Page de la série')).toBeInTheDocument();
  const post = apiFetch.mock.calls.find((c) => c[0] === '/api/runs' && c[1]?.method === 'POST')!;
  expect(post[1].body).toMatchObject({ suiteId: 's1', modelIds: ['m1'] });
});

test('juge requis si un test est noté par le juge, avec alerte si le juge est aussi évalué', async () => {
  const user = userEvent.setup();
  SUITE.tests.push(st('t3', 'Évaluer', 'judge'));
  try {
    await toParams(user);
    expect(screen.getByText(/noté par le juge/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Continuer/ })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Modèle juge'), 'm1');
    expect(screen.getByRole('button', { name: /^Continuer/ })).toBeEnabled();
    expect(screen.getByText(/juge est aussi un modèle évalué/)).toBeInTheDocument();
  } finally {
    SUITE.tests.pop();
  }
});

test('le nom par défaut suit la source : repasser en tests à la carte abandonne le nom de la suite', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('radio', { name: /Polyvalence/ }));
  await user.click(screen.getByRole('tab', { name: 'Tests à la carte' }));
  await user.click(await screen.findByRole('checkbox', { name: /Résumer/ }));
  await next(user);
  await user.click(await screen.findByRole('checkbox', { name: /Claude Opus/ }));
  await next(user);
  expect(screen.getByLabelText('Nom de la série')).toHaveAttribute('placeholder', expect.stringMatching(/^Série du /));
  await next(user);
  await waitFor(() => expect(estimateCalls().length).toBeGreaterThan(0));
  const body = estimateCalls().at(-1)![1].body;
  expect(body.name).toMatch(/^Série du /);
  expect(body.suiteId).toBeUndefined();
});

test('plafond à plus de 4 décimales et pondération vide sont refusés', async () => {
  const user = userEvent.setup();
  await toParams(user);
  fireEvent.change(screen.getByLabelText('Plafond en $ (facultatif)'), { target: { value: '1,23456' } });
  expect(screen.getByRole('button', { name: /^Continuer/ })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Plafond en $ (facultatif)'), { target: { value: '1,2345' } });
  expect(screen.getByRole('button', { name: /^Continuer/ })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Vitesse'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Qualité'), { target: { value: '70' } });
  expect(screen.getByText(/Total : 100/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Continuer/ })).toBeDisabled();
});

test('estimation périmée : « Lancer » reste désactivé jusqu’à l’estimation du nouveau corps', async () => {
  const user = userEvent.setup();
  await toParams(user);
  await next(user);
  const launch = screen.getByRole('button', { name: 'Lancer la série' });
  await waitFor(() => expect(launch).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Retour' }));
  fireEvent.change(screen.getByLabelText('Répétitions'), { target: { value: '3' } });
  let resolve!: (v: unknown) => void;
  const pending = new Promise((r) => (resolve = r));
  const impl = apiFetch.getMockImplementation()!;
  apiFetch.mockImplementation((path: string, init?: { method?: string }) =>
    path === '/api/runs/estimate' ? pending : impl(path, init),
  );
  await next(user);
  expect(screen.getByRole('button', { name: 'Lancer la série' })).toBeDisabled();
  await waitFor(() => expect(estimateCalls().at(-1)![1].body.repetitions).toBe(3));
  expect(screen.getByRole('button', { name: 'Lancer la série' })).toBeDisabled();
  resolve({ estimate: ESTIMATE });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Lancer la série' })).toBeEnabled());
});
