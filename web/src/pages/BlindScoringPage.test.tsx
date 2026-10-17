import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { BlindScoringPage } from './BlindScoringPage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  apiFetch,
}));

const question = (over: Record<string, unknown> = {}) => ({
  runTestId: 'q1',
  runName: 'Série clients',
  testName: 'Réponse empathique',
  systemPrompt: null,
  userPrompt: 'Rédige une réponse empathique.',
  attachments: [{ index: 0, originalName: 'courrier.png', mime: 'image/png' }],
  answers: [
    { letter: 'A', responseText: 'Réponse **un**', myScore: null, myComment: null },
    { letter: 'B', responseText: 'Réponse deux', myScore: null, myComment: null },
  ],
  complete: false,
  ...over,
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/a-noter/q1']}>
        <Routes>
          <Route path="/a-noter/:runTestId" element={<BlindScoringPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const REVEAL = [
  { letter: 'A', modelName: 'Mistral Large', color: '#f06' },
  { letter: 'B', modelName: 'Claude Sonnet', color: '#09f' },
];

const rate = async (letter: string, n: number) => {
  const group = screen.getByRole('radiogroup', { name: `Note de la réponse ${letter}` });
  await userEvent.click(within(group).getByRole('radio', { name: String(n) }));
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(question());
});

test('question : prompt, pièces jointes, réponses A, B sans nom de modèle ; note 0 à 10 et commentaire', async () => {
  renderPage();
  expect(await screen.findByText(/Rédige une réponse empathique/)).toBeInTheDocument();
  expect(screen.getByAltText('courrier.png')).toHaveAttribute('src', '/api/scoring/questions/q1/attachments/0');
  expect(screen.getByRole('article', { name: 'Réponse A' })).toHaveTextContent('Réponse un');
  expect(screen.getByRole('article', { name: 'Réponse B' })).toBeInTheDocument();
  const group = screen.getByRole('radiogroup', { name: 'Note de la réponse A' });
  expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(
    Array.from({ length: 11 }, (_, i) => String(i)),
  );
  expect(screen.getByLabelText('Commentaire sur la réponse A')).toBeInTheDocument();
});

test('sans question complète, aucun nom de modèle ni pastille, même si des données de révélation traînent', async () => {
  apiFetch.mockResolvedValue(question({ complete: false, reveal: REVEAL }));
  renderPage();
  await screen.findByText(/Rédige une réponse empathique/);
  expect(screen.queryByText('Mistral Large')).toBeNull();
  expect(screen.queryByText('Claude Sonnet')).toBeNull();
  expect(document.querySelector('.reveal-in')).toBeNull();
});

test('question déjà complète : modèles révélés d’emblée et notes préremplies', async () => {
  apiFetch.mockResolvedValue(
    question({
      complete: true,
      answers: [
        { letter: 'A', responseText: 'Réponse un', myScore: 7, myComment: null },
        { letter: 'B', responseText: 'Réponse deux', myScore: 3, myComment: null },
      ],
      reveal: REVEAL,
    }),
  );
  renderPage();
  expect(await screen.findByText('Mistral Large')).toBeInTheDocument();
  expect(screen.getByText('Claude Sonnet')).toBeInTheDocument();
  const group = screen.getByRole('radiogroup', { name: 'Note de la réponse A' });
  expect(within(group).getByRole('radio', { name: '7' })).toHaveAttribute('aria-checked', 'true');
});

test('aucune réponse : « Enregistrer » reste désactivé', async () => {
  apiFetch.mockResolvedValue(question({ answers: [], attachments: [] }));
  renderPage();
  expect(await screen.findByRole('button', { name: 'Enregistrer et révéler' })).toBeDisabled();
});

test('flèches : changent la note, un seul arrêt de tabulation par réponse', async () => {
  renderPage();
  await screen.findByText(/Rédige une réponse empathique/);
  const group = screen.getByRole('radiogroup', { name: 'Note de la réponse A' });
  const radios = within(group).getAllByRole('radio');
  expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);
  await userEvent.click(radios[4]!);
  await userEvent.keyboard('{ArrowRight}');
  expect(within(group).getByRole('radio', { name: '5' })).toHaveAttribute('aria-checked', 'true');
  expect(within(group).getByRole('radio', { name: '5' })).toHaveFocus();
  await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
  expect(within(group).getByRole('radio', { name: '3' })).toHaveAttribute('aria-checked', 'true');
  expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);
});

test('« Enregistrer » désactivé tant que tout n’est pas noté ; après enregistrement, modèles révélés et compteur invalidé', async () => {
  const client = renderPage();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const save = await screen.findByRole('button', { name: 'Enregistrer et révéler' });
  expect(save).toBeDisabled();
  await rate('A', 7);
  expect(save).toBeDisabled();
  await rate('B', 3);
  await userEvent.type(screen.getByLabelText('Commentaire sur la réponse B'), ' trop court ');
  expect(save).toBeEnabled();

  apiFetch.mockResolvedValueOnce(
    question({
      complete: true,
      answers: [
        { letter: 'A', responseText: 'Réponse **un**', myScore: 7, myComment: null },
        { letter: 'B', responseText: 'Réponse deux', myScore: 3, myComment: 'trop court' },
      ],
      reveal: REVEAL,
    }),
  );
  await userEvent.click(save);

  expect(await screen.findByText('Mistral Large')).toBeInTheDocument();
  expect(screen.getByText('Claude Sonnet')).toBeInTheDocument();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['scoring', 'todo'] });
  const put = apiFetch.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(put?.[0]).toBe('/api/scoring/questions/q1/manual');
  expect(put?.[1].body).toEqual({
    scores: [
      { letter: 'A', score: 7 },
      { letter: 'B', score: 3, comment: 'trop court' },
    ],
  });
});

test('échec de l’enregistrement : message en français', async () => {
  renderPage();
  const save = await screen.findByRole('button', { name: 'Enregistrer et révéler' });
  await rate('A', 5);
  await rate('B', 5);
  apiFetch.mockRejectedValueOnce(new ApiError('network', 0, 'x'));
  await userEvent.click(save);
  expect(await screen.findByRole('alert')).toHaveTextContent('Le serveur ne répond pas');
});

test('échec de l’enregistrement (réponse arrivée entre-temps) : question relue, nouvelles réponses affichées, message conservé', async () => {
  renderPage();
  const save = await screen.findByRole('button', { name: 'Enregistrer et révéler' });
  await rate('A', 5);
  await rate('B', 5);
  apiFetch.mockRejectedValueOnce(new ApiError('validation', 400, 'Notez toutes les réponses de la question'));
  apiFetch.mockResolvedValueOnce(
    question({
      answers: [
        { letter: 'A', responseText: 'Réponse deux', myScore: null, myComment: null },
        { letter: 'B', responseText: 'Réponse trois arrivée', myScore: null, myComment: null },
        { letter: 'C', responseText: 'Réponse **un**', myScore: null, myComment: null },
      ],
    }),
  );
  await userEvent.click(save);
  expect(await screen.findByRole('article', { name: 'Réponse C' })).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Notez toutes les réponses de la question');
  // Formulaire reparti de zéro : les lettres désignent d'autres réponses.
  const group = screen.getByRole('radiogroup', { name: 'Note de la réponse A' });
  expect(within(group).getByRole('radio', { name: '5' })).toHaveAttribute('aria-checked', 'false');
  expect(apiFetch.mock.calls.filter(([url, init]) => url === '/api/scoring/questions/q1' && init?.method !== 'PUT')).toHaveLength(2);
});

test('question pas encore prête (réponses en attente) : message en français', async () => {
  apiFetch.mockReset();
  apiFetch.mockRejectedValue(new ApiError('question_not_ready', 409, 'x'));
  renderPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('pas encore arrivées');
});
