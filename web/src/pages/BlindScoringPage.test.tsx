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
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/a-noter/q1']}>
        <Routes>
          <Route path="/a-noter/:runTestId" element={<BlindScoringPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

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
  expect(screen.queryByText(/Mistral|Claude/)).toBeNull();
});

test('« Enregistrer » désactivé tant que tout n’est pas noté ; après enregistrement, modèles révélés', async () => {
  renderPage();
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
      reveal: [
        { letter: 'A', modelName: 'Mistral Large', color: '#f06' },
        { letter: 'B', modelName: 'Claude Sonnet', color: '#09f' },
      ],
    }),
  );
  await userEvent.click(save);

  expect(await screen.findByText('Mistral Large')).toBeInTheDocument();
  expect(screen.getByText('Claude Sonnet')).toBeInTheDocument();
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
