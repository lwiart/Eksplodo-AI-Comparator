import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

const slider = (letter: string) => screen.getByRole('slider', { name: `Note de la réponse ${letter}` });
const field = (letter: string) => screen.getByRole('textbox', { name: `Note de la réponse ${letter}, saisie au clavier` });
const rate = (letter: string, n: number) => {
  fireEvent.change(slider(letter), { target: { value: String(n) } });
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(question());
});

test('question : prompt, pièces jointes, réponses A, B sans nom de modèle ; note 0 à 100 et commentaire', async () => {
  renderPage();
  expect(await screen.findByText(/Rédige une réponse empathique/)).toBeInTheDocument();
  // Vignette affichée en inline ; le nom reste un lien de téléchargement.
  const thumb = screen.getByRole('button', { name: 'Afficher courrier.png' });
  expect(thumb.querySelector('img')).toHaveAttribute('src', '/api/scoring/questions/q1/attachments/0?inline=1');
  expect(screen.getByRole('link', { name: 'courrier.png' })).toHaveAttribute('href', '/api/scoring/questions/q1/attachments/0');
  expect(screen.getByRole('article', { name: 'Réponse A' })).toHaveTextContent('Réponse un');
  expect(screen.getByRole('article', { name: 'Réponse B' })).toBeInTheDocument();
  const range = slider('A');
  expect(range).toHaveAttribute('min', '0');
  expect(range).toHaveAttribute('max', '100');
  expect(range).toHaveAttribute('step', '5');
  expect(range).toHaveAttribute('aria-valuetext', 'non notée');
  expect(field('A')).toHaveValue('');
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
        { letter: 'A', responseText: 'Réponse un', myScore: 70, myComment: null },
        { letter: 'B', responseText: 'Réponse deux', myScore: 30, myComment: null },
      ],
      reveal: REVEAL,
    }),
  );
  renderPage();
  expect(await screen.findByText('Mistral Large')).toBeInTheDocument();
  expect(screen.getByText('Claude Sonnet')).toBeInTheDocument();
  expect(slider('A')).toHaveValue('70');
  expect(slider('A')).toHaveAttribute('aria-valuetext', '70 sur 100');
  expect(field('A')).toHaveValue('70');
  expect(field('B')).toHaveValue('30');
});

test('aucune réponse : « Enregistrer » reste désactivé', async () => {
  apiFetch.mockResolvedValue(question({ answers: [], attachments: [] }));
  renderPage();
  expect(await screen.findByRole('button', { name: 'Enregistrer et révéler' })).toBeDisabled();
});

test('curseur et champ : la note suit dans les deux sens, curseur par pas de 5', async () => {
  renderPage();
  await screen.findByText(/Rédige une réponse empathique/);
  expect(slider('A').tabIndex).toBe(0);
  expect(slider('A')).toHaveAttribute('step', '5');
  // Curseur : le champ et la valeur lue suivent.
  rate('A', 45);
  expect(slider('A')).toHaveAttribute('aria-valuetext', '45 sur 100');
  expect(field('A')).toHaveValue('45');
  rate('A', 40);
  expect(field('A')).toHaveValue('40');
  // Champ : tout entier de 0 à 100, le curseur suit.
  await userEvent.clear(field('A'));
  await userEvent.type(field('A'), '73');
  expect(slider('A')).toHaveAttribute('aria-valuetext', '73 sur 100');
  // La réponse B reste non notée.
  expect(slider('B')).toHaveAttribute('aria-valuetext', 'non notée');
});

test('« Enregistrer » désactivé tant que tout n’est pas noté ; après enregistrement, modèles révélés et compteur invalidé', async () => {
  const client = renderPage();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const save = await screen.findByRole('button', { name: 'Enregistrer et révéler' });
  expect(save).toBeDisabled();
  rate('A', 70);
  expect(save).toBeDisabled();
  rate('B', 30);
  await userEvent.type(screen.getByLabelText('Commentaire sur la réponse B'), ' trop court ');
  expect(save).toBeEnabled();

  apiFetch.mockResolvedValueOnce(
    question({
      complete: true,
      answers: [
        { letter: 'A', responseText: 'Réponse **un**', myScore: 70, myComment: null },
        { letter: 'B', responseText: 'Réponse deux', myScore: 30, myComment: 'trop court' },
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
      { letter: 'A', score: 70 },
      { letter: 'B', score: 30, comment: 'trop court' },
    ],
  });
});

test('échec de l’enregistrement : message en français', async () => {
  renderPage();
  const save = await screen.findByRole('button', { name: 'Enregistrer et révéler' });
  rate('A', 55);
  rate('B', 55);
  apiFetch.mockRejectedValueOnce(new ApiError('network', 0, 'x'));
  await userEvent.click(save);
  expect(await screen.findByRole('alert')).toHaveTextContent('Le serveur ne répond pas');
});

test('échec de l’enregistrement (réponse arrivée entre-temps) : question relue, nouvelles réponses affichées, message conservé', async () => {
  renderPage();
  const save = await screen.findByRole('button', { name: 'Enregistrer et révéler' });
  rate('A', 55);
  rate('B', 55);
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
  expect(slider('A')).toHaveAttribute('aria-valuetext', 'non notée');
  expect(field('A')).toHaveValue('');
  expect(apiFetch.mock.calls.filter(([url, init]) => url === '/api/scoring/questions/q1' && init?.method !== 'PUT')).toHaveLength(2);
});

test('question pas encore prête (réponses en attente) : message en français', async () => {
  apiFetch.mockReset();
  apiFetch.mockRejectedValue(new ApiError('question_not_ready', 409, 'x'));
  renderPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('pas encore arrivées');
});

test('pièce jointe en grand : visionneuse avec le nom du fichier, aucun nom de modèle', async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Afficher courrier.png' }));
  const dialog = screen.getByRole('dialog', { name: 'courrier.png' });
  expect(within(dialog).getByRole('img', { name: 'courrier.png' })).toHaveAttribute('src', '/api/scoring/questions/q1/attachments/0?inline=1');
  expect(within(dialog).getByRole('link', { name: 'Télécharger' })).toHaveAttribute('href', '/api/scoring/questions/q1/attachments/0');
  expect(dialog.textContent).not.toMatch(/Claude|GPT|Mistral|modèle/i);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
});
