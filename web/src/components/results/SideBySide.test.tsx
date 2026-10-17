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
  finalScore: 9.5,
  autoScore: 9.5,
  manualAvg: null,
  overrideScore: null,
  judgeRationale: 'Complet et structuré.',
  ttftMs: 900,
  tokensPerS: 74,
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
      answer({ resultId: 'a2', modelName: 'GPT Test', color: '#3FA2E0', finalScore: 8.8, autoScore: 8.8, judgeRationale: null, ttftMs: 600, tokensPerS: 96, costUsd: 0.014 }),
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
            mean: 7.5,
            stdDev: 2.5,
            scores: [
              { userName: 'Laurent', score: 5, comment: 'Trop long' },
              { userName: 'Camille', score: 10, comment: null },
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
  expect(within(card).getByLabelText('Note finale')).toHaveTextContent('9,5');
  expect(within(card).getByText('auto 9,5')).toBeInTheDocument();
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
      answer({ hiddenUntilScored: true, responseText: 'TEXTE SECRET', finalScore: 6.3, autoScore: 6.3, judgeRationale: 'RAISON SECRETE' }),
      answer({ resultId: 'a2', modelName: 'GPT Secret', hiddenUntilScored: true, responseText: 'AUTRE SECRET', finalScore: 4.1 }),
    ],
  };
  renderBlock(false);
  expect(await screen.findByText(/2 masquées/)).toBeInTheDocument();
  const html = document.body.textContent ?? '';
  for (const secret of ['TEXTE SECRET', 'AUTRE SECRET', 'RAISON SECRETE', 'GPT Secret', 'Claude Opus', '6,3', '4,1']) expect(html).not.toContain(secret);
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

test('Admin : imposer une note 7,5 puis la retirer ; relancer le juge sur un test avec un autre juge', async () => {
  const user = userEvent.setup();
  renderBlock(true);
  const card = await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });

  await user.click(within(card).getByRole('button', { name: 'Imposer une note' }));
  const input = within(card).getByLabelText('Note imposée (0 à 10)');
  await user.type(input, '10,5');
  expect(within(card).getByText('Entre 0 et 10, une décimale au plus (ex. 7,5).')).toBeInTheDocument();
  expect(within(card).getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
  await user.clear(input);
  await user.type(input, '7,5');
  // Le serveur renverra la note imposée au rechargement des réponses.
  answersBody = { test: TEST_INFO, answers: [answer({ overrideScore: 7.5, finalScore: 7.5 })] };
  await user.click(within(card).getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/scoring/results/a1/override', { method: 'PUT', body: { score: 7.5 } }));
  // La saisie se referme et les réponses sont rechargées.
  await waitFor(() => expect(within(card).queryByLabelText('Note imposée (0 à 10)')).toBeNull());
  await waitFor(() => expect(apiFetch.mock.calls.filter((c) => c[0] === '/api/runs/r1/answers/rt1').length).toBeGreaterThan(1));

  // Avec une note imposée, le retrait est proposé.
  expect(await screen.findByText(/imposée 7,5/)).toBeInTheDocument();
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
  answersBody = { test: { ...TEST_INFO, scoringMethod: 'manual' }, answers: [answer({ judgeRationale: null, autoScore: null, manualAvg: 7, finalScore: 7 })] };
  renderBlock(true);
  await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  expect(screen.queryByRole('button', { name: /Relancer le juge/ })).toBeNull();
});

test('Admin : la touche Entrée enregistre la note imposée', async () => {
  const user = userEvent.setup();
  renderBlock(true);
  const card = await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  await user.click(within(card).getByRole('button', { name: 'Imposer une note' }));
  await user.type(within(card).getByLabelText('Note imposée (0 à 10)'), '6{Enter}');
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/scoring/results/a1/override', { method: 'PUT', body: { score: 6 } }));
});

test('Admin : la touche Entrée sur une note invalide n’envoie rien', async () => {
  const user = userEvent.setup();
  renderBlock(true);
  const card = await screen.findByRole('article', { name: 'Claude Opus, répétition 1' });
  await user.click(within(card).getByRole('button', { name: 'Imposer une note' }));
  await user.type(within(card).getByLabelText('Note imposée (0 à 10)'), '12{Enter}');
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
  expect(parseOverride('7,5')).toBe(7.5);
  expect(parseOverride('10')).toBe(10);
  expect(parseOverride('0')).toBe(0);
  expect(parseOverride(',5')).toBe(0.5);
  expect(parseOverride('.5')).toBe(0.5);
  expect(parseOverride('10,5')).toBeUndefined();
  expect(parseOverride('7,55')).toBeUndefined();
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
