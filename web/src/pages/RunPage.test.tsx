import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { AuthContext, type PublicUser, type Role } from '../auth/AuthProvider';
import { MODELS as RANKED_MODELS, RANKING } from '../components/results/ranking.fixtures';
import { RunPage } from './RunPage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  apiFetch,
}));

const counts = (over: Record<string, number> = {}) => ({ pending: 0, running: 0, done: 0, error: 0, timeout: 0, unsupported: 0, truncated: 0, total: 0, ...over });
const cell = (modelId: string, over: Record<string, number> = {}) => ({ modelId, pending: 0, running: 0, done: 0, failed: 0, unsupported: 0, truncated: 0, ...over });

const SUMMARY = {
  id: 'r1',
  name: 'Polyvalence octobre',
  status: 'running',
  pauseReason: null,
  suiteName: 'Polyvalence',
  modelCount: 2,
  testCount: 3,
  repetitions: 1,
  judgeModelName: 'Claude Opus',
  modelsCostUsd: 2.41,
  judgeCostUsd: 0,
  budgetUsd: 5,
  createdAt: '2026-10-17T12:30:00.000Z',
  startedAt: '2026-10-17T12:30:02.000Z',
  completedAt: null,
  counts: counts({ done: 1, running: 1, error: 1, pending: 2, unsupported: 1, total: 6 }),
};

const MODELS = [
  { id: 'm1', name: 'Claude Opus', color: '#F0631F' },
  { id: 'm2', name: 'GPT Test', color: '#3FA2E0' },
];

const PROGRESS = {
  status: 'running',
  pauseReason: null,
  counts: counts({ done: 1, running: 1, error: 1, pending: 2, unsupported: 1, total: 6 }),
  modelsCostUsd: 2.41,
  judgeCostUsd: 0,
  budgetUsd: 5,
  nextCallMaxCostUsd: null,
  judgePending: 0,
  startedAt: '2026-10-17T12:30:02.000Z',
  elapsedMs: 60_000,
  etaSeconds: 125,
  running: [{ modelId: 'm2', testName: 'Résumer' }],
  activity: [
    { resultId: 'x2', testName: 'Extraire', modelId: 'm1', modelName: 'Claude Opus', color: '#F0631F', status: 'error', totalMs: null, costUsd: null, completedAt: '2026-10-17T12:32:08.000Z', hiddenUntilScored: false },
    { resultId: 'x1', testName: 'Résumer', modelId: 'm1', modelName: 'Claude Opus', color: '#F0631F', status: 'done', totalMs: 3100, costUsd: 0.0021, completedAt: '2026-10-17T12:31:57.000Z', hiddenUntilScored: false },
  ],
  matrix: [
    { runTestId: 'rt1', testName: 'Résumer', cells: [cell('m1', { done: 1 }), cell('m2', { running: 1 })] },
    { runTestId: 'rt2', testName: 'Extraire', cells: [cell('m1', { failed: 1 }), cell('m2', { pending: 1 })] },
    { runTestId: 'rt3', testName: 'Traduire', cells: [cell('m1', { pending: 1 }), cell('m2', { unsupported: 1 })] },
  ],
  models: MODELS,
};

const result = (over: Record<string, unknown>) => ({
  id: 'res',
  runTestId: 'rt1',
  testName: 'Résumer',
  category: 'Rédaction',
  modelId: 'm1',
  modelName: 'Claude Opus',
  color: '#F0631F',
  repetition: 1,
  status: 'done',
  attempts: 1,
  responseText: 'ok',
  finishReason: 'stop',
  inputTokens: 100,
  outputTokens: 200,
  reasoningTokens: null,
  tokensEstimated: false,
  ttftMs: 400,
  totalMs: 3000,
  tokensPerS: 50,
  costUsd: 0.002,
  costSource: 'computed',
  errorCode: null,
  errorMessage: null,
  scoreStatus: 'pending',
  completedAt: '2026-10-17T12:31:57.000Z',
  hiddenUntilScored: false,
  ...over,
});
const RESULTS = [
  result({ id: 'a1' }),
  result({ id: 'a2', ttftMs: 600, tokensPerS: 70, costUsd: 0.004 }),
  result({ id: 'a3', status: 'error', ttftMs: null, tokensPerS: null, costUsd: null }),
  result({ id: 'a4', status: 'timeout', ttftMs: null, tokensPerS: null, costUsd: null }),
  result({ id: 'b1', modelId: 'm2', modelName: 'GPT Test', color: '#3FA2E0', ttftMs: 1000, tokensPerS: 10, costUsd: null }),
  result({ id: 'b2', modelId: 'm2', modelName: 'GPT Test', color: '#3FA2E0', ttftMs: 2000, tokensPerS: 20, costUsd: 0.01 }),
  result({ id: 'b3', modelId: 'm2', modelName: 'GPT Test', color: '#3FA2E0', ttftMs: 9000, tokensPerS: 30, costUsd: 0.02 }),
  result({ id: 'b4', modelId: 'm2', modelName: 'GPT Test', color: '#3FA2E0', status: 'unsupported', ttftMs: null, tokensPerS: null, costUsd: null }),
];

const CATALOG = [
  { id: 'm1', displayName: 'Claude Opus', providerName: 'Anthropic', color: '#F0631F', available: true },
  { id: 'm3', displayName: 'Mistral Large', providerName: 'Mistral', color: '#7CC4EF', available: true },
  { id: 'm4', displayName: 'Modèle sans clé', providerName: 'Autre', color: '#FFFFFF', available: false },
];

/** Classement renvoyé par défaut : aucune qualité (rien n'est encore noté, ou masqué pour un Utilisateur). */
const UNSCORED_RANKING = { ...RANKING, models: RANKING.models.map((m) => ({ ...m, quality: null })) };

// Les curseurs Radix et les graphes Recharts observent leur taille ; jsdom n'a pas de ResizeObserver.
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

let ranking: unknown;
let progressQueue: unknown[];
let summary: Record<string, unknown>;
/** Si défini, la prochaine réponse de l'avancement attend cette promesse (requête encore en vol). */
let holdProgress: Promise<void> | null;
beforeEach(() => {
  progressQueue = [];
  summary = SUMMARY;
  ranking = UNSCORED_RANKING;
  holdProgress = null;
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/api/runs/r1' && !init) return Promise.resolve({ run: summary });
    if (path === '/api/runs/r1/progress') {
      const progress = progressQueue.length > 1 ? progressQueue.shift() : progressQueue[0];
      const hold = holdProgress;
      holdProgress = null;
      return hold ? hold.then(() => ({ progress })) : Promise.resolve({ progress });
    }
    if (path === '/api/runs/r1/ranking') return Promise.resolve(ranking);
    if (path === '/api/runs/r1/results') return Promise.resolve({ results: RESULTS });
    if (path.startsWith('/api/runs/r1/answers/'))
      return Promise.resolve({
        test: { name: 'Résumer', category: 'Rédaction', userPrompt: 'Résume.', scoringMethod: 'judge', attachments: [] },
        answers: [{ resultId: 'a1', modelName: 'Claude Opus', color: '#F0631F', repetition: 1, status: 'done', responseText: 'Texte', hiddenUntilScored: false, finalScore: 8, autoScore: 8, manualAvg: null, overrideScore: null, judgeRationale: null, ttftMs: 400, tokensPerS: 50, costUsd: 0.002, errorMessage: null }],
      });
    if (path === '/api/models') return Promise.resolve({ models: CATALOG });
    if (init?.method) return Promise.resolve({ run: summary });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

function renderPage(role: Role = 'admin', ...progress: unknown[]) {
  progressQueue = progress.length > 0 ? progress : [PROGRESS];
  const user: PublicUser = { id: 'u1', email: 'a@example.test', name: 'Laurent', role };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })}>
      <AuthContext.Provider value={{ user, loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() }}>
        <MemoryRouter initialEntries={['/series/r1']}>
          <Routes>
            <Route path="/series/:id" element={<RunPage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}
const progressCalls = () => apiFetch.mock.calls.filter((c) => c[0] === '/api/runs/r1/progress').length;
const answersCalls = () => apiFetch.mock.calls.filter((c) => String(c[0]).startsWith('/api/runs/r1/answers/')).length;
const rankingCalls = () => apiFetch.mock.calls.filter((c) => c[0] === '/api/runs/r1/ranking').length;
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

test('en-tête : nom, suite, modèles × répétitions, juge, coût modèles + juge, statut', async () => {
  renderPage();
  const title = await screen.findByRole('heading', { level: 1, name: 'Polyvalence octobre' });
  const facts = within(screen.getByRole('list', { name: 'Caractéristiques de la série' }));
  expect(facts.getByText('Polyvalence')).toBeInTheDocument();
  expect(facts.getByText('3 tests, 2 modèles × 1 répétition')).toBeInTheDocument();
  expect(facts.getByText('Claude Opus')).toBeInTheDocument();
  expect(facts.getByText('2,41 $ modèles + 0,00 $ juge')).toBeInTheDocument();
  expect(within(title.parentElement!).getByText('En cours')).toBeInTheDocument();
});

test('réponses tronquées comptées comme terminées ; plus d’appel à faire : notes du juge en attente au lieu d’un temps restant', async () => {
  renderPage('admin', {
    ...PROGRESS,
    counts: counts({ done: 3, truncated: 2, error: 1, total: 6 }),
    running: [],
    etaSeconds: 0,
    judgePending: 4,
  });
  const bar = await screen.findByRole('progressbar', { name: 'Avancement' });
  expect(bar).toHaveAttribute('aria-valuenow', '100');
  expect(screen.getByText('6 / 6 appels')).toBeInTheDocument();
  expect(screen.getByText('Notation du juge : 4 en attente')).toBeInTheDocument();
  expect(screen.queryByText(/^≈/)).toBeNull();
});

test('vue en direct : progression, matrice test × modèle, fil d’activité', async () => {
  renderPage();
  const bar = await screen.findByRole('progressbar', { name: 'Avancement' });
  expect(bar).toHaveAttribute('aria-valuenow', '50');
  expect(screen.getByText('3 / 6 appels')).toBeInTheDocument();
  expect(screen.getByText('2,41 $')).toBeInTheDocument();
  expect(screen.getByText('sur 5,00 $')).toBeInTheDocument();
  expect(screen.getByText('≈ 2 min 5 s')).toBeInTheDocument();

  const matrix = within(screen.getByRole('table', { name: 'Progression par test et par modèle' }));
  expect(matrix.getByRole('columnheader', { name: 'Test' })).toBeInTheDocument();
  expect(matrix.getByRole('columnheader', { name: 'Claude Opus' })).toBeInTheDocument();
  expect(matrix.getByRole('columnheader', { name: 'GPT Test' })).toBeInTheDocument();
  expect(matrix.getByRole('rowheader', { name: 'Traduire' })).toBeInTheDocument();
  expect(matrix.getByLabelText('Résumer, Claude Opus : 1 réussi')).toBeInTheDocument();
  expect(matrix.getByLabelText('Résumer, GPT Test : 1 en cours')).toBeInTheDocument();
  expect(matrix.getByLabelText('Extraire, Claude Opus : 1 en erreur')).toBeInTheDocument();
  expect(matrix.getByLabelText('Extraire, GPT Test : 1 à faire')).toBeInTheDocument();
  expect(matrix.getByLabelText('Traduire, GPT Test : non supporté')).toBeInTheDocument();

  const items = within(screen.getByRole('list', { name: 'Fil d’activité' })).getAllByRole('listitem');
  expect(items).toHaveLength(2);
  expect(items[0]).toHaveTextContent('Claude Opus');
  expect(items[0]).toHaveTextContent('Extraire');
  expect(items[0]).toHaveTextContent('Erreur');
  expect(items[1]).toHaveTextContent('Réponse en 3,1 s');
});

test('interrogation toutes les 2 s, arrêtée à completed', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  renderPage('admin', PROGRESS, PROGRESS, { ...PROGRESS, status: 'completed', etaSeconds: 0, running: [] });
  await screen.findByRole('progressbar', { name: 'Avancement' });
  expect(progressCalls()).toBe(1);
  await tick(2000);
  expect(progressCalls()).toBe(2);
  await tick(2000);
  expect(progressCalls()).toBe(3);
  await tick(10_000);
  expect(progressCalls()).toBe(3);
  expect(await screen.findByRole('table', { name: 'Métriques par modèle' })).toBeInTheDocument();
});

test('onglet caché : pas d’interrogation, une requête au retour', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  renderPage();
  await screen.findByRole('progressbar', { name: 'Avancement' });
  expect(progressCalls()).toBe(1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
  await tick(10_000);
  expect(progressCalls()).toBe(1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
  await tick(100);
  expect(progressCalls()).toBe(2);
});

const setVisibility = (state: 'hidden' | 'visible') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
};

test('requête terminée onglet caché : l’interrogation reprend au retour sur l’onglet', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  renderPage();
  await screen.findByRole('progressbar', { name: 'Avancement' });
  let release!: () => void;
  holdProgress = new Promise<void>((resolve) => {
    release = resolve;
  });
  await tick(2000);
  expect(progressCalls()).toBe(2); // requête en vol
  setVisibility('hidden');
  await act(async () => {
    release();
    await Promise.resolve();
  });
  await tick(10_000);
  expect(progressCalls()).toBe(2);
  setVisibility('visible');
  await tick(100);
  expect(progressCalls()).toBe(3);
  await tick(2000);
  expect(progressCalls()).toBe(4);
  await tick(2000);
  expect(progressCalls()).toBe(5);
});

test('pause budget : message et champ de plafond ; reprendre envoie PATCH puis resume', async () => {
  const user = userEvent.setup();
  summary = { ...SUMMARY, status: 'paused', pauseReason: 'budget', modelsCostUsd: 1, budgetUsd: 1 };
  // Prochain appel (le moins cher en attente) : 0,2345 $ au plus → minimum utile 1,2345 $ (jamais arrondi en dessous).
  renderPage('admin', { ...PROGRESS, status: 'paused', pauseReason: 'budget', modelsCostUsd: 1, budgetUsd: 1, nextCallMaxCostUsd: 0.2345, running: [] });
  expect(await screen.findByText(/Plafond atteint/)).toHaveTextContent('1,00 $');
  const field = screen.getByLabelText('Nouveau plafond en $');
  expect(field).toHaveAccessibleDescription('Au moins 1,2345 $ pour lancer un appel de plus.');
  const submit = screen.getByRole('button', { name: 'Relever le plafond et reprendre' });
  expect(submit).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Reprendre' })).toBeNull();
  await user.type(field, '0,9');
  expect(screen.getByText('Saisissez au moins 1,2345 $ pour lancer un appel de plus.')).toBeInTheDocument();
  expect(submit).toBeDisabled();
  await user.clear(field);
  await user.type(field, '1,2344');
  expect(submit).toBeDisabled();
  await user.clear(field);
  await user.type(field, '1,2345');
  expect(submit).toBeEnabled();
  await user.clear(field);
  await user.type(field, '2,12345');
  expect(submit).toBeDisabled();
  await user.clear(field);
  await user.type(field, '2,5');
  expect(submit).toBeEnabled();
  await user.click(submit);

  const writes = apiFetch.mock.calls.filter((c) => c[1]?.method);
  expect(writes).toEqual([
    ['/api/runs/r1', { method: 'PATCH', body: { budgetUsd: 2.5 } }],
    ['/api/runs/r1/resume', { method: 'POST' }],
  ]);
});

test('Admin : mettre en pause, relancer les erreurs, ajouter un modèle disponible hors série', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Mettre en pause' }));
  expect(apiFetch).toHaveBeenCalledWith('/api/runs/r1/pause', { method: 'POST' });
  await user.click(screen.getByRole('button', { name: 'Relancer les erreurs' }));
  expect(apiFetch).toHaveBeenCalledWith('/api/runs/r1/retry-errors', { method: 'POST' });

  await user.click(screen.getByRole('button', { name: 'Ajouter un modèle' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Ajouter un modèle' }));
  expect(dialog.queryByRole('checkbox', { name: /Claude Opus/ })).toBeNull();
  expect(dialog.queryByRole('checkbox', { name: /Modèle sans clé/ })).toBeNull();
  await user.click(await dialog.findByRole('checkbox', { name: /Mistral Large/ }));
  await user.click(dialog.getByRole('button', { name: 'Ajouter à la série' }));
  expect(apiFetch).toHaveBeenCalledWith('/api/runs/r1/models', { method: 'POST', body: { modelIds: ['m3'] } });

  // Rouvert après l'ajout : aucune sélection héritée.
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await user.click(screen.getByRole('button', { name: 'Ajouter un modèle' }));
  const again = within(await screen.findByRole('dialog', { name: 'Ajouter un modèle' }));
  expect(await again.findByRole('checkbox', { name: /Mistral Large/ })).not.toBeChecked();
  expect(again.getByRole('button', { name: 'Ajouter à la série' })).toBeDisabled();
});

test('Utilisateur : aucun bouton de contrôle', async () => {
  renderPage('user', { ...PROGRESS, status: 'paused', pauseReason: 'budget', running: [] });
  await screen.findByRole('progressbar', { name: 'Avancement' });
  for (const name of ['Mettre en pause', 'Reprendre', 'Relancer les erreurs', 'Ajouter un modèle', 'Relever le plafond et reprendre']) {
    expect(screen.queryByRole('button', { name })).toBeNull();
  }
  expect(screen.queryByLabelText('Nouveau plafond en $')).toBeNull();
});

test('bouton « Partager » absent pour un Utilisateur', async () => {
  renderPage('user');
  await screen.findByRole('progressbar', { name: 'Avancement' });
  expect(screen.queryByRole('button', { name: 'Partager' })).toBeNull();
});

test('bouton « Partager » présent pour l’Admin', async () => {
  renderPage('admin');
  expect(await screen.findByRole('button', { name: 'Partager' })).toBeInTheDocument();
});

test('série terminée : tableau des métriques par modèle', async () => {
  summary = { ...SUMMARY, status: 'completed', completedAt: '2026-10-17T12:40:00.000Z' };
  renderPage('user', { ...PROGRESS, status: 'completed', etaSeconds: 0, running: [] });
  const table = within(await screen.findByRole('table', { name: 'Métriques par modèle' }));
  const opus = within(table.getByRole('rowheader', { name: 'Claude Opus' }).closest('tr')!);
  expect(opus.getAllByRole('cell').map((c) => c.textContent)).toEqual(['2', '2', '500 ms', '60 tokens/s', '0,003 $', '—']);
  const gpt = within(table.getByRole('rowheader', { name: 'GPT Test' }).closest('tr')!);
  expect(gpt.getAllByRole('cell').map((c) => c.textContent)).toEqual(['3', '0', '2 s', '20 tokens/s', '0,015 $', '—']);
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByTestId('live-flow-fallback')).toBeNull();
});

test('série terminée : vue résultats (podium, pondération, classement) avant les métriques', async () => {
  summary = { ...SUMMARY, status: 'completed', completedAt: '2026-10-17T12:40:00.000Z' };
  ranking = RANKING;
  renderPage('admin', { ...PROGRESS, status: 'completed', etaSeconds: 0, running: [] });
  expect(await screen.findByRole('list', { name: 'Podium' })).toBeInTheDocument();
  expect(screen.getByRole('slider', { name: 'Qualité' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enregistrer comme pondération par défaut' })).toBeInTheDocument();
  expect(screen.getByRole('table', { name: 'Classement détaillé' })).toBeInTheDocument();
  expect(await screen.findByRole('table', { name: 'Métriques par modèle' })).toBeInTheDocument();
});

test('série terminée, qualité masquée (Utilisateur sans notes) : « — » sans planter', async () => {
  summary = { ...SUMMARY, status: 'completed', completedAt: '2026-10-17T12:40:00.000Z' };
  renderPage('user', { ...PROGRESS, status: 'completed', etaSeconds: 0, running: [] });
  const table = within(await screen.findByRole('table', { name: 'Classement détaillé' }));
  const alpha = [...table.getByRole('rowheader', { name: /Alpha/ }).closest('tr')!.querySelectorAll('td')].map((c) => c.textContent);
  expect(alpha.slice(0, 3)).toEqual(['—', '—', '—']);
  expect(screen.getByText(/Aucun modèle noté/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Enregistrer comme pondération/ })).toBeNull();
});

test('série en cours : la vue résultats apparaît dès qu’un modèle a une qualité', async () => {
  ranking = { ...RANKING, models: RANKED_MODELS };
  renderPage('admin');
  expect(await screen.findByRole('list', { name: 'Podium' })).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'Avancement' })).toBeInTheDocument();
});

test('série en cours sans qualité : pas de vue résultats', async () => {
  renderPage('admin');
  await screen.findByRole('progressbar', { name: 'Avancement' });
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/runs/r1/ranking'));
  expect(screen.queryByRole('table', { name: 'Classement détaillé' })).toBeNull();
});

test('sans WebGL : repli SVG de la scène', async () => {
  renderPage();
  const fallback = await screen.findByTestId('live-flow-fallback');
  expect(within(fallback as unknown as HTMLElement).getAllByTestId('live-flow-node')).toHaveLength(2);
  expect(document.querySelector('canvas')).toBeNull();
});

test('série terminée : réponses côte à côte avec les tests de la série', async () => {
  summary = { ...SUMMARY, status: 'completed', completedAt: '2026-10-17T12:40:00.000Z' };
  renderPage('admin', { ...PROGRESS, status: 'completed', etaSeconds: 0, running: [] });
  expect(await screen.findByRole('heading', { name: /Réponses côte à côte/ })).toBeInTheDocument();
  expect(await screen.findByRole('article', { name: 'Claude Opus, répétition 1' })).toBeInTheDocument();
  expect(apiFetch).toHaveBeenCalledWith('/api/runs/r1/answers/rt1');
  expect(screen.getByRole('option', { name: 'Traduire' })).toBeInTheDocument();
});

test('série en cours avec notes du juge en attente : « Notation en cours »', async () => {
  renderPage('user', { ...PROGRESS, judgePending: 2 });
  expect(await screen.findByText('Notation en cours · 2 en attente')).toBeInTheDocument();
});

test('série en pause avec une qualité : réponses côte à côte accessibles, sans badge si rien n’est en attente', async () => {
  ranking = { ...RANKING, models: RANKED_MODELS };
  renderPage('admin', { ...PROGRESS, status: 'paused', pauseReason: 'user' });
  expect(await screen.findByRole('article', { name: 'Claude Opus, répétition 1' })).toBeInTheDocument();
  expect(screen.queryByText(/Notation en cours/)).toBeNull();
});

test('réponses côte à côte relues comme le classement pendant la série, puis une dernière fois quand elle se termine', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  ranking = { ...RANKING, models: RANKED_MODELS };
  const judging = { ...PROGRESS, judgePending: 1 };
  const done = { ...PROGRESS, status: 'completed', etaSeconds: 0, running: [], judgePending: 0 };
  // Avancement interrogé toutes les 2 s : en cours jusqu'à 10 s, terminée à 12 s.
  renderPage('admin', judging, judging, judging, judging, judging, judging, done);
  expect(await screen.findByRole('article', { name: 'Claude Opus, répétition 1' })).toBeInTheDocument();
  expect(answersCalls()).toBe(1);
  await tick(10_000);
  expect(answersCalls()).toBe(2);
  const [answersBefore, rankingBefore] = [answersCalls(), rankingCalls()];
  await tick(2_000);
  await waitFor(() => expect(answersCalls()).toBe(answersBefore + 1));
  expect(rankingCalls()).toBe(rankingBefore + 1);
  // Série terminée et notes rendues : plus aucune interrogation.
  await tick(30_000);
  expect(answersCalls()).toBe(answersBefore + 1);
  expect(rankingCalls()).toBe(rankingBefore + 1);
});

test('notes du juge rendues alors que la série reste active : dernière relecture des réponses et du classement', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  ranking = { ...RANKING, models: RANKED_MODELS };
  renderPage('admin', { ...PROGRESS, judgePending: 2 }, PROGRESS);
  expect(await screen.findByRole('article', { name: 'Claude Opus, répétition 1' })).toBeInTheDocument();
  const [answersBefore, rankingBefore] = [answersCalls(), rankingCalls()];
  await tick(2_000);
  await waitFor(() => expect(answersCalls()).toBe(answersBefore + 1));
  expect(rankingCalls()).toBe(rankingBefore + 1);
});

/** PATCH du nom : la série renvoyée (et relue ensuite) porte le nouveau nom. */
function acceptRename() {
  const base = apiFetch.getMockImplementation()!;
  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: { name?: string } }) => {
    if (path === '/api/runs/r1' && init?.method === 'PATCH') {
      summary = { ...summary, name: init.body!.name! };
      return Promise.resolve({ run: summary });
    }
    return base(path, init);
  });
}
const patchCalls = () => apiFetch.mock.calls.filter((c) => c[0] === '/api/runs/r1' && c[1]?.method === 'PATCH');
const runGets = () => apiFetch.mock.calls.filter((c) => c[0] === '/api/runs/r1' && !c[1]).length;

test('Admin : renommer la série depuis le crayon, Entrée enregistre et relit la série', async () => {
  const user = userEvent.setup();
  acceptRename();
  renderPage();
  await screen.findByRole('heading', { level: 1, name: 'Polyvalence octobre' });
  const gets = runGets();
  await user.click(screen.getByRole('button', { name: 'Renommer la série' }));
  const field = screen.getByRole('textbox', { name: 'Nom de la série' });
  expect(field).toHaveValue('Polyvalence octobre');
  expect(field).toHaveFocus();
  await user.clear(field);
  await user.type(field, '  Comparatif de novembre {Enter}');
  expect(await screen.findByRole('heading', { level: 1, name: 'Comparatif de novembre' })).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Nom de la série' })).toBeNull();
  expect(patchCalls()).toEqual([['/api/runs/r1', { method: 'PATCH', body: { name: 'Comparatif de novembre' } }]]);
  await waitFor(() => expect(runGets()).toBeGreaterThan(gets)); // cache de la série invalidé
});

test('Admin : clic sur le titre pour éditer, perte du focus enregistre', async () => {
  const user = userEvent.setup();
  acceptRename();
  renderPage();
  await user.click(await screen.findByRole('heading', { level: 1, name: 'Polyvalence octobre' }));
  const field = screen.getByRole('textbox', { name: 'Nom de la série' });
  await user.clear(field);
  await user.type(field, 'Série renommée');
  await user.tab();
  expect(await screen.findByRole('heading', { level: 1, name: 'Série renommée' })).toBeInTheDocument();
  expect(patchCalls()).toHaveLength(1);
});

test('Admin : Échap annule sans appel ; nom vide refusé avec un message', async () => {
  const user = userEvent.setup();
  acceptRename();
  renderPage();
  await user.click(await screen.findByRole('heading', { level: 1, name: 'Polyvalence octobre' }));
  await user.type(screen.getByRole('textbox', { name: 'Nom de la série' }), 'Brouillon{Escape}');
  expect(screen.getByRole('heading', { level: 1, name: 'Polyvalence octobre' })).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Nom de la série' })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Renommer la série' }));
  const field = screen.getByRole('textbox', { name: 'Nom de la série' });
  expect(field).toHaveValue('Polyvalence octobre'); // le brouillon annulé n'est pas repris
  await user.clear(field);
  await user.type(field, '   {Enter}');
  expect(screen.getByRole('alert')).toHaveTextContent('Le nom de la série ne peut pas être vide.');
  expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(field).toHaveAccessibleDescription('Le nom de la série ne peut pas être vide.');
  expect(patchCalls()).toHaveLength(0);
});

test('Admin : erreur du serveur affichée, le champ reste ouvert', async () => {
  const user = userEvent.setup();
  const base = apiFetch.getMockImplementation()!;
  apiFetch.mockImplementation((path: string, init?: { method?: string }) =>
    path === '/api/runs/r1' && init?.method === 'PATCH' ? Promise.reject({ code: 'forbidden' }) : base(path, init),
  );
  renderPage();
  await user.click(await screen.findByRole('heading', { level: 1, name: 'Polyvalence octobre' }));
  const field = screen.getByRole('textbox', { name: 'Nom de la série' });
  await user.type(field, ' bis{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent("Vous n'avez pas les droits nécessaires pour cette action.");
  expect(screen.getByRole('textbox', { name: 'Nom de la série' })).toHaveValue('Polyvalence octobre bis');
});

test('Utilisateur : titre sans renommage', async () => {
  const user = userEvent.setup();
  renderPage('user');
  const title = await screen.findByRole('heading', { level: 1, name: 'Polyvalence octobre' });
  expect(screen.queryByRole('button', { name: 'Renommer la série' })).toBeNull();
  await user.click(title);
  expect(screen.queryByRole('textbox', { name: 'Nom de la série' })).toBeNull();
});

test('titre long : il passe à la ligne, pastille et « Partager » restent sur la même rangée ; édition sur toute la largeur', async () => {
  const user = userEvent.setup();
  renderPage();
  const title = await screen.findByRole('heading', { level: 1, name: 'Polyvalence octobre' });
  expect(title).toHaveClass('min-w-0', '[overflow-wrap:anywhere]');
  const header = title.closest('header')!;
  // Aucun retour à la ligne de l'en-tête : le titre s'enroule dans sa colonne, le reste garde sa place.
  expect(header).not.toHaveClass('flex-wrap');
  expect(title.parentElement).toHaveClass('min-w-0', 'flex-1');
  expect(within(header).getByRole('button', { name: /Partager/ })).toHaveClass('shrink-0');
  await user.click(screen.getByRole('button', { name: 'Renommer la série' }));
  const field = screen.getByRole('textbox', { name: 'Nom de la série' });
  expect(field.tagName).toBe('TEXTAREA');
  expect(field).toHaveClass('w-full');
  // Échap referme la zone sans enregistrer (Entrée, qui enregistre, est couverte plus haut).
  await user.type(field, '{Escape}');
  expect(screen.queryByRole('textbox', { name: 'Nom de la série' })).toBeNull();
});
