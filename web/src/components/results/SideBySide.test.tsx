import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import { parseOverride, SideBySide } from './SideBySide';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api/client')>()), apiFetch }));

const TESTS = [
  { runTestId: 'rt1', testName: 'Résumer un CCTP' },
  { runTestId: 'rt2', testName: 'Extraire' },
];

const answer = (over: Record<string, unknown>) => ({
  resultId: 'a1',
  modelName: 'Claude Opus',
  color: '#F0631F',
  repetition: 1,
  status: 'done',
  responseText: 'Voici **le résumé**.',
  hiddenUntilScored: false,
  finalScore: 95,
  autoScore: 95,
  manualAvg: null,
  overrideScore: null,
  judgeRationale: 'Complet et structuré.',
  ttftMs: 900,
  tokensPerS: 74,
  inputTokens: 1200,
  outputTokens: 3400,
  reasoningTokens: 800,
  tokensEstimated: false,
  costUsd: 0.021,
  errorMessage: null,
  ...over,
});

const CATALOG = [
  { id: 'm1', displayName: 'Claude Opus', providerName: 'Anthropic', color: '#F0631F', available: true },
  { id: 'm3', displayName: 'Mistral Large', providerName: 'Mistral', color: '#7CC4EF', available: true },
  { id: 'm4', displayName: 'Sans clé', providerName: 'Autre', color: '#FFFFFF', available: false },
];

const TEST_INFO = { name: 'Résumer un CCTP', category: 'Rédaction', userPrompt: 'Résume.', scoringMethod: 'judge', attachments: [] };

let answersBody: unknown;
beforeEach(() => {
  apiFetch.mockReset();
  answersBody = {
    test: TEST_INFO,
    answers: [
      answer({}),
      answer({ resultId: 'a2', modelName: 'GPT Test', color: '#3FA2E0', finalScore: 88, autoScore: 88, judgeRationale: null, ttftMs: 600, tokensPerS: 96, costUsd: 0.014 }),
    ],
  };
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path.startsWith('/api/runs/r1/answers/')) return Promise.resolve(answersBody);
    if (path === '/api/models') return Promise.resolve({ models: CATALOG });
    if (path === '/api/scoring/runs/r1/spread')
      return Promise.resolve({
        items: [
          {
            resultId: 'a1',
            runTestId: 'rt1',
            testName: 'Résumer un CCTP',
            modelName: 'Claude Opus',
            raters: 2,
            mean: 75,
            stdDev: 25,
            scores: [
              { userName: 'Laurent', score: 50, comment: 'Trop long' },
              { userName: 'Camille', score: 100, comment: null },
            ],
          },
        ],
      });
    if (init?.method) return Promise.resolve({ queued: 2, result: {} });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});

function renderBlock(isAdmin: boolean, judgePending = 0) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SideBySide runId="r1" tests={TESTS} isAdmin={isAdmin} judgePending={judgePending} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('réponses côte à côte avec justification du juge et métriques', async () => {
  renderBlock(false);
  const card = await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  expect(within(card).getByText('le résumé').tagName).toBe('STRONG');
  expect(within(card).getByLabelText('Note finale')).toHaveTextContent('95');
  expect(within(card).getByText('auto 95')).toBeInTheDocument();
  expect(within(card).getByText('Juge : Complet et structuré.')).toBeInTheDocument();
  expect(within(card).getByText('900 ms')).toBeInTheDocument();
  expect(within(card).getByText('74 tokens/s')).toBeInTheDocument();
  expect(within(card).getByText('0,021 $')).toBeInTheDocument();
  expect(screen.getByRole('article', { name: 'GPT Test, répétition 1' })).toBeInTheDocument();
  expect(screen.getByText(/test 1 \/ 2/)).toBeInTheDocument();
  expect(apiFetch).toHaveBeenCalledWith('/api/runs/r1/answers/rt1');
  // Utilisateur : aucune action d'Admin ni onglet des écarts.
  expect(screen.queryByRole('button', { name: /Imposer une note/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Relancer le juge/ })).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Écarts entre évaluateurs' })).toBeNull();
});

test('changer de test charge ses réponses', async () => {
  const user = userEvent.setup();
  renderBlock(false);
  await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  await user.selectOptions(screen.getByLabelText('Test'), 'rt2');
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/runs/r1/answers/rt2'));
});

test('réponse masquée pour l’Utilisateur qui n’a pas noté, avec lien vers la notation', async () => {
  const user = userEvent.setup();
  answersBody = {
    test: TEST_INFO,
    answers: [answer({ responseText: null, hiddenUntilScored: true, finalScore: null, judgeRationale: null })],
  };
  renderBlock(false);
  expect(await screen.findByText(/Notez cette question pour voir les réponses/)).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Noter cette question' })).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Noter cette question' })).toHaveAttribute('href', '/a-noter/rt1');
  expect(screen.queryByRole('article')).toBeNull();
  await user.click(screen.getByRole('tab', { name: 'À l’aveugle' }));
  expect(screen.getByRole('link', { name: 'Noter à l’aveugle' })).toHaveAttribute('href', '/a-noter/rt1');
});

test('réponses masquées : même si le serveur renvoie texte, note ou modèle, rien n’apparaît', async () => {
  answersBody = {
    test: TEST_INFO,
    answers: [
      answer({ hiddenUntilScored: true, responseText: 'TEXTE SECRET', finalScore: 63, autoScore: 63, judgeRationale: 'RAISON SECRETE' }),
      answer({ resultId: 'a2', modelName: 'GPT Secret', hiddenUntilScored: true, responseText: 'AUTRE SECRET', finalScore: 41 }),
    ],
  };
  renderBlock(false);
  expect(await screen.findByText(/2 masquées/)).toBeInTheDocument();
  const html = document.body.textContent ?? '';
  for (const secret of ['TEXTE SECRET', 'AUTRE SECRET', 'RAISON SECRETE', 'GPT Secret', 'Claude Opus', '63', '41']) expect(html).not.toContain(secret);
});

test('changer de test efface le message de relance', async () => {
  const user = userEvent.setup();
  renderBlock(true);
  await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  await user.click(screen.getByRole('button', { name: 'Relancer le juge sur ce test' }));
  expect(await screen.findByText('2 notation(s) relancée(s).')).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Test'), 'rt2');
  expect(screen.queryByText('2 notation(s) relancée(s).')).toBeNull();
});

test('Admin : imposer une note 75 puis la retirer ; relancer le juge sur un test avec un autre juge', async () => {
  const user = userEvent.setup();
  renderBlock(true);
  const card = await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });

  await user.click(within(card).getByRole('button', { name: 'Imposer une note' }));
  const input = within(card).getByLabelText('Note imposée (0 à 100)');
  await user.type(input, '101');
  expect(within(card).getByText('Nombre entier entre 0 et 100 (ex. 75).')).toBeInTheDocument();
  expect(within(card).getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
  await user.clear(input);
  await user.type(input, '7,5');
  expect(within(card).getByText('Nombre entier entre 0 et 100 (ex. 75).')).toBeInTheDocument();
  await user.clear(input);
  await user.type(input, '75');
  // Le serveur renverra la note imposée au rechargement des réponses.
  answersBody = { test: TEST_INFO, answers: [answer({ overrideScore: 75, finalScore: 75 })] };
  await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/scoring/results/a1/override', { method: 'PUT', body: { score: 75 } }));
  // La saisie se referme et les réponses sont rechargées.
  await waitFor(() => expect(within(card).queryByLabelText('Note imposée (0 à 100)')).toBeNull());
  await waitFor(() => expect(apiFetch.mock.calls.filter((c) => c[0] === '/api/runs/r1/answers/rt1').length).toBeGreaterThan(1));

  // Avec une note imposée, le retrait est proposé.
  expect(await screen.findByText(/imposée 75/)).toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: 'Retirer la note imposée' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/scoring/results/a1/override', { method: 'PUT', body: { score: null } }));

  await user.selectOptions(screen.getByLabelText('Juge pour la relance'), 'm3');
  expect(screen.queryByRole('option', { name: 'Sans clé' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Relancer le juge sur ce test' }));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/api/runs/r1/rescore', { method: 'POST', body: { scope: 'test', runTestId: 'rt1', judgeModelId: 'm3' } }),
  );
  expect(await screen.findByText('2 notation(s) relancée(s).')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Relancer le juge sur toute la série' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/runs/r1/rescore', { method: 'POST', body: { scope: 'run', judgeModelId: 'm3' } }));
});

test('Admin : relancer le juge sur un seul résultat, avec le juge de la série', async () => {
  const user = userEvent.setup();
  renderBlock(true);
  await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  await user.click(screen.getAllByRole('button', { name: 'Relancer le juge sur ce résultat' })[0]!);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/runs/r1/rescore', { method: 'POST', body: { scope: 'result', resultId: 'a1' } }));
});

test('« Notation en cours » quand des notes du juge sont en attente', async () => {
  renderBlock(false, 3);
  expect(await screen.findByRole('status')).toHaveTextContent('Notation en cours · 3 en attente');
});

test('Admin : l’onglet des écarts affiche le détail des évaluateurs du test', async () => {
  const user = userEvent.setup();
  renderBlock(true);
  await user.click(await screen.findByRole('tab', { name: 'Écarts entre évaluateurs' }));
  const table = within(await screen.findByRole('table', { name: 'Écarts entre évaluateurs' }));
  expect(table.getByRole('rowheader', { name: 'Claude Opus' })).toBeInTheDocument();
});

test('Admin, test à réponse attendue : « Correction automatique », aucune relance du juge', async () => {
  answersBody = {
    test: { ...TEST_INFO, scoringMethod: 'expected' },
    answers: [answer({ judgeRationale: 'Réponse identique à la réponse attendue.' })],
  };
  renderBlock(true);
  const card = await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  expect(within(card).getByText('Correction automatique : Réponse identique à la réponse attendue.')).toBeInTheDocument();
  expect(within(card).queryByText(/^Juge :/)).toBeNull();
  expect(within(card).getByRole('button', { name: 'Imposer une note' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Relancer le juge/ })).toBeNull();
  expect(screen.queryByLabelText('Juge pour la relance')).toBeNull();
});

test('Admin, test manuel : aucune relance du juge', async () => {
  answersBody = { test: { ...TEST_INFO, scoringMethod: 'manual' }, answers: [answer({ judgeRationale: null, autoScore: null, manualAvg: 70, finalScore: 70 })] };
  renderBlock(true);
  await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  expect(screen.queryByRole('button', { name: /Relancer le juge/ })).toBeNull();
});

test('Admin : la touche Entrée enregistre la note imposée', async () => {
  const user = userEvent.setup();
  renderBlock(true);
  const card = await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  await user.click(within(card).getByRole('button', { name: 'Imposer une note' }));
  await user.type(within(card).getByLabelText('Note imposée (0 à 100)'), '60{Enter}');
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/scoring/results/a1/override', { method: 'PUT', body: { score: 60 } }));
});

test('Admin : la touche Entrée sur une note invalide n’envoie rien', async () => {
  const user = userEvent.setup();
  renderBlock(true);
  const card = await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  await user.click(within(card).getByRole('button', { name: 'Imposer une note' }));
  await user.type(within(card).getByLabelText('Note imposée (0 à 100)'), '120{Enter}');
  expect(apiFetch.mock.calls.some(([url]) => String(url).includes('/override'))).toBe(false);
});

test('relance refusée (test non jugé) : message français dédié', async () => {
  const user = userEvent.setup();
  renderBlock(true);
  await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  const { ApiError } = await import('../../api/client');
  apiFetch.mockRejectedValueOnce(new ApiError('not_rescorable', 409, 'x'));
  await user.click(screen.getByRole('button', { name: 'Relancer le juge sur ce test' }));
  expect(await screen.findByText(/n’est pas noté par le juge/)).toBeInTheDocument();
});

test('analyse de la note imposée', () => {
  expect(parseOverride('75')).toBe(75);
  expect(parseOverride('100')).toBe(100);
  expect(parseOverride('0')).toBe(0);
  expect(parseOverride('7,5')).toBeUndefined();
  expect(parseOverride(',5')).toBeUndefined();
  expect(parseOverride('.5')).toBeUndefined();
  expect(parseOverride('101')).toBeUndefined();
  expect(parseOverride('10,5')).toBeUndefined();
  expect(parseOverride('-1')).toBeUndefined();
  expect(parseOverride('')).toBeUndefined();
});

test('pièces jointes du test : vignettes au-dessus des réponses, visionneuse inline, téléchargement', async () => {
  const user = userEvent.setup();
  answersBody = {
    test: {
      ...TEST_INFO,
      attachments: [
        { index: 0, originalName: 'plan.png', mime: 'image/png', pages: null },
        { index: 1, originalName: 'cctp.pdf', mime: 'application/pdf', pages: 3 },
      ],
    },
    answers: [answer({})],
  };
  renderBlock(true);
  const gallery = await screen.findByRole('list', { name: 'Pièces jointes du test' });
  expect(within(gallery).getByRole('link', { name: 'cctp.pdf' })).toHaveAttribute('href', '/api/runs/r1/answers/rt1/attachments/1');
  await user.click(within(gallery).getByRole('button', { name: 'Afficher cctp.pdf' }));
  const dialog = screen.getByRole('dialog', { name: 'cctp.pdf' });
  expect(dialog.querySelector('iframe')).toHaveAttribute('src', '/api/runs/r1/answers/rt1/attachments/1?inline=1');
  await user.keyboard('{ArrowRight}');
  expect(within(dialog).getByRole('img', { name: 'plan.png' })).toHaveAttribute('src', '/api/runs/r1/answers/rt1/attachments/0?inline=1');
});

test('réponse tronquée : message orange avec la cause et l’indication de relance ; erreur longue sans débordement', async () => {
  answersBody = {
    test: TEST_INFO,
    answers: [
      answer({
        resultId: 't1',
        status: 'truncated',
        responseText: null,
        finalScore: null,
        autoScore: null,
        judgeRationale: null,
        errorMessage: 'Aucun texte : la limite de 1500 tokens a été atteinte pendant la réflexion, avant la réponse.',
      }),
      answer({ resultId: 'e1', modelName: 'GPT Test', status: 'error', responseText: null, finalScore: null, errorMessage: 'Requête refusée : {"error":{"message":"file_must_have_a_file_id_or_file_data"}}' }),
    ],
  };
  renderBlock(true);
  const card = await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  const message = within(card).getByText(/Réponse tronquée\./).closest('p')!;
  expect(message).toHaveTextContent('la limite de 1500 tokens a été atteinte pendant la réflexion');
  expect(message).toHaveClass('text-truncated-text');
  expect(within(card).getByText(/Relancer les erreurs/)).toBeInTheDocument();
  const error = within(screen.getByRole('article', { name: 'GPT Test, répétition 1' })).getByText(/Requête refusée/);
  expect(error).toHaveClass('[overflow-wrap:anywhere]', 'text-bad');
});

test('filtre de la matrice : tests de la catégorie et réponses du modèle seulement ; « Retirer le filtre »', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const models = [
    { modelId: 'm1', name: 'Claude Opus' },
    { modelId: 'm2', name: 'GPT Test' },
  ];
  const tests = [
    { runTestId: 'rt1', testName: 'Résumer un CCTP', category: 'Rédaction' },
    { runTestId: 'rt2', testName: 'Extraire', category: 'Extraction' },
    { runTestId: 'rt3', testName: 'Lettre', category: 'Rédaction' },
  ];
  answersBody = {
    test: TEST_INFO,
    answers: [answer({ modelId: 'm1' }), answer({ resultId: 'a2', modelId: 'm2', modelName: 'GPT Test' })],
  };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SideBySide runId="r1" tests={tests} isAdmin={false} filter={{ modelId: 'm1', category: 'Rédaction' }} onFilterChange={onChange} models={models} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('article', { name: 'Claude Opus, répétition 1' })).toBeInTheDocument();
  expect(screen.queryByRole('article', { name: 'GPT Test, répétition 1' })).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Filtre : Claude Opus · Rédaction (2 tests)');
  const options = within(screen.getByLabelText('Test')).getAllByRole('option').map((o) => o.textContent);
  expect(options).toEqual(['Tous les tests (2)', 'Résumer un CCTP', 'Lettre']);
  expect(screen.getByLabelText('Catégorie')).toHaveValue('Rédaction');
  expect(screen.getByLabelText('Modèle')).toHaveValue('m1');
  await user.selectOptions(screen.getByLabelText('Modèle'), 'm2');
  expect(onChange).toHaveBeenLastCalledWith({ modelId: 'm2', category: 'Rédaction' });
  await user.click(screen.getByRole('button', { name: 'Retirer le filtre' }));
  expect(onChange).toHaveBeenLastCalledWith({ modelId: null, category: null });
});

test('clic sur une note de la matrice : tous les tests de la catégorie, réponses du modèle en pleine largeur', async () => {
  const tests = [
    { runTestId: 'rt1', testName: 'Résumer un CCTP', category: 'Rédaction' },
    { runTestId: 'rt2', testName: 'Extraire', category: 'Extraction' },
    { runTestId: 'rt3', testName: 'Lettre', category: 'Rédaction' },
  ];
  answersBody = { test: TEST_INFO, answers: [answer({ modelId: 'm1' }), answer({ resultId: 'a2', modelId: 'm2', modelName: 'GPT Test' })] };
  const models = [
    { modelId: 'm1', name: 'Claude Opus' },
    { modelId: 'm2', name: 'GPT Test' },
  ];
  const view = (focusKey: number) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SideBySide runId="r1" tests={tests} isAdmin={false} filter={{ modelId: 'm1', category: 'Rédaction' }} onFilterChange={vi.fn()} models={models} focusKey={focusKey} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(view(1));
  expect(screen.getByLabelText('Test')).toHaveValue('__tous__');
  const blocks = await screen.findAllByRole('region');
  const names = blocks.map((b) => b.getAttribute('aria-label')).filter((n) => n === 'Résumer un CCTP' || n === 'Lettre' || n === 'Extraire');
  expect(names).toEqual(['Résumer un CCTP', 'Lettre']);
  await waitFor(() => expect(screen.getAllByRole('article', { name: 'Claude Opus, répétition 1' })).toHaveLength(2));
  const cards = screen.getAllByRole('article', { name: 'Claude Opus, répétition 1' });
  expect(screen.queryByRole('article', { name: 'GPT Test, répétition 1' })).toBeNull();
  expect(cards[0]?.parentElement).not.toHaveClass('md:grid-cols-2');
});

test('listes Catégorie et Modèle sans matrice : le composant filtre seul', async () => {
  const user = userEvent.setup();
  const tests = [
    { runTestId: 'rt1', testName: 'Résumer un CCTP', category: 'Rédaction' },
    { runTestId: 'rt2', testName: 'Extraire', category: 'Extraction' },
  ];
  answersBody = { test: TEST_INFO, answers: [answer({ modelId: 'm1' }), answer({ resultId: 'a2', modelId: 'm2', modelName: 'GPT Test' })] };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SideBySide runId="r1" tests={tests} isAdmin={false} models={[{ modelId: 'm1', name: 'Claude Opus' }, { modelId: 'm2', name: 'GPT Test' }]} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole('article', { name: 'GPT Test, répétition 1' });
  await user.selectOptions(screen.getByLabelText('Modèle'), 'm2');
  expect(screen.queryByRole('article', { name: 'Claude Opus, répétition 1' })).toBeNull();
  await user.selectOptions(screen.getByLabelText('Catégorie'), 'Extraction');
  expect(within(screen.getByLabelText('Test')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Extraire']);
  expect(screen.getByRole('status')).toHaveTextContent('Filtre : GPT Test · Extraction (1 test)');
});

test('nom du test cliquable : détail avec consigne système, prompt et résultat attendu', async () => {
  const user = userEvent.setup();
  answersBody = {
    test: {
      ...TEST_INFO,
      tags: ['marchés'],
      systemPrompt: 'Tu es juriste.',
      temperature: 0.2,
      maxTokens: 1200,
      scoringMethod: 'expected',
      scoringConfig: { mode: 'contains', items: ['délai', 'pénalités'], ignoreCase: true },
    },
    answers: [answer({ modelId: 'm1' })],
  };
  renderBlock(false);
  await user.click(await screen.findByRole('button', { name: 'Résumer un CCTP' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Résumer un CCTP' }));
  expect(dialog.getByText('Tu es juriste.')).toBeInTheDocument();
  expect(dialog.getByText('Résume.')).toBeInTheDocument();
  expect(dialog.getByText('Réponse attendue')).toBeInTheDocument();
  expect(dialog.getByText(/La réponse doit contenir/)).toBeInTheDocument();
  expect(dialog.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['délai', 'pénalités']);
  expect(dialog.getByText('1 200 tokens')).toBeInTheDocument();
  expect(dialog.getByText('marchés')).toBeInTheDocument();
});

test('Admin : réponses cochées puis « Relancer la sélection » (limite de tokens actuelle, sans case à cocher)', async () => {
  const user = userEvent.setup();
  renderBlock(true);
  await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  expect(screen.queryByRole('region', { name: 'Relance des réponses cochées' })).toBeNull();
  await user.click(screen.getByRole('checkbox', { name: 'Relancer Claude Opus, répétition 1' }));
  const bar = within(screen.getByRole('region', { name: 'Relance des réponses cochées' }));
  expect(bar.getByText('1 réponse à relancer')).toBeInTheDocument();
  expect(bar.queryByRole('checkbox')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Cocher ces réponses pour les relancer' }));
  expect(bar.getByText('2 réponses à relancer')).toBeInTheDocument();
  await user.click(bar.getByRole('button', { name: /Relancer la sélection/ }));
  expect(apiFetch).toHaveBeenCalledWith('/api/runs/r1/rerun', { method: 'POST', body: { resultIds: ['a1', 'a2'] } });
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Relance des réponses cochées' })).toBeNull());
});

test('Utilisateur : pas de case « Relancer » ; réponse en attente affichée comme telle, sans coût', async () => {
  answersBody = { test: TEST_INFO, answers: [answer({ status: 'pending', responseText: null, finalScore: null, autoScore: null, judgeRationale: null, ttftMs: null, tokensPerS: null })] };
  renderBlock(false);
  const card = await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  expect(within(card).getByText('En attente de lancement.')).toBeInTheDocument();
  expect(within(card).queryByText('Pas de réponse pour ce résultat.')).toBeNull();
  expect(within(card).queryByText(/0,021/)).toBeNull();
  expect(screen.queryByRole('checkbox', { name: /Relancer/ })).toBeNull();
});

test('filtre « Statut » : tronquées seulement, tous les tests concernés l’un sous l’autre', async () => {
  const user = userEvent.setup();
  const tests = [
    { runTestId: 'rt1', testName: 'Résumer un CCTP', category: 'Rédaction', truncatedModelIds: ['m2'], failedModelIds: [] },
    { runTestId: 'rt2', testName: 'Extraire', category: 'Extraction', truncatedModelIds: [], failedModelIds: ['m1'] },
    { runTestId: 'rt3', testName: 'Lettre', category: 'Rédaction', truncatedModelIds: ['m2'], failedModelIds: [] },
  ];
  answersBody = {
    test: TEST_INFO,
    answers: [answer({ modelId: 'm1' }), answer({ resultId: 'a2', modelId: 'm2', modelName: 'GPT Test', status: 'truncated', responseText: null, errorMessage: 'Aucun texte' })],
  };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SideBySide runId="r1" tests={tests} isAdmin={false} models={[{ modelId: 'm1', name: 'Claude Opus' }, { modelId: 'm2', name: 'GPT Test' }]} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  const status = screen.getByLabelText('Statut');
  expect(within(status).getAllByRole('option').map((o) => o.textContent)).toEqual(['Toutes les réponses', 'Tronquées (2 tests)', 'En erreur (1 test)']);
  await user.selectOptions(status, 'truncated');
  expect(screen.getByLabelText('Test')).toHaveValue('__tous__');
  expect(within(screen.getByLabelText('Test')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Tous les tests (2)', 'Résumer un CCTP', 'Lettre']);
  await waitFor(() => expect(screen.getAllByRole('article', { name: 'GPT Test, répétition 1' })).toHaveLength(2));
  expect(screen.queryByRole('article', { name: 'Claude Opus, répétition 1' })).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('· réponses tronquées (2 tests)');
  await user.click(screen.getByRole('button', { name: 'Retirer le filtre' }));
  expect(status).toHaveValue('all');
});

test('un seul test choisi : nom cliquable, catégorie et question affichés au-dessus des réponses', async () => {
  renderBlock(false);
  const block = await screen.findByRole('region', { name: 'Résumer un CCTP' });
  expect(within(block).getByRole('button', { name: 'Résumer un CCTP' })).toBeInTheDocument();
  expect(block).toHaveTextContent('Rédaction');
  expect(within(block).getByText('Résume.')).toBeInTheDocument();
});

test('pied des cartes : « Tokens entrée/réflexion/sortie » après le premier token et le débit', async () => {
  answersBody = { test: TEST_INFO, answers: [answer({}), answer({ resultId: 'a2', modelName: 'GPT Test', reasoningTokens: null, tokensEstimated: true })] };
  renderBlock(false);
  const card = await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  const footer = card.querySelector('footer')!;
  expect(footer.textContent).toMatch(/1er token.*Débit.*Tokens entrée\/réflexion\/sortie :\s1\s200 \/ 800 \/ 3\s400.*Coût/);
  const other = (await screen.findByRole('article', { name: 'GPT Test, répétition 1' })).querySelector('footer')!;
  expect(other.textContent).toMatch(/Tokens entrée\/réflexion\/sortie :\s≈ 1\s200 \/ - \/ 3\s400/);
});
