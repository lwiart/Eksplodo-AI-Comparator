import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { DefaultJudgeCard } from './DefaultJudgeCard';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));

const model = (id: string, displayName: string, available = true) => ({ id, displayName, available });
const MODELS = [model('m1', 'Claude Opus'), model('m2', 'GPT Test'), model('m3', 'Sans clé', false)];

let current: string | null = 'm1';
let putError: ApiError | null = null;
beforeEach(() => {
  current = 'm1';
  putError = null;
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: { defaultJudgeModelId: string | null } }) => {
    if (path === '/api/models') return Promise.resolve({ models: MODELS });
    if (path === '/api/settings/scoring' && init?.method === 'PUT') {
      if (putError) return Promise.reject(putError);
      current = init.body!.defaultJudgeModelId;
      return Promise.resolve({ defaultJudgeModelId: current });
    }
    if (path === '/api/settings/scoring') return Promise.resolve({ defaultJudgeModelId: current });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});

function renderCard() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DefaultJudgeCard />
    </QueryClientProvider>,
  );
}

test('Admin : le juge actuel est affiché, on le change et on l’enregistre', async () => {
  const user = userEvent.setup();
  renderCard();
  const select = (await screen.findByLabelText('Modèle juge')) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe('m1'));
  expect(screen.queryByRole('option', { name: 'Sans clé' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
  await user.selectOptions(select, 'm2');
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/settings/scoring', { method: 'PUT', body: { defaultJudgeModelId: 'm2' } }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled());
});

test('« Aucun » retire le juge par défaut', async () => {
  const user = userEvent.setup();
  renderCard();
  const select = (await screen.findByLabelText('Modèle juge')) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe('m1'));
  await user.selectOptions(select, '');
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/settings/scoring', { method: 'PUT', body: { defaultJudgeModelId: null } }));
});

test('refus du serveur : message en français', async () => {
  putError = new ApiError('model_not_found', 400, 'Modèle introuvable ou désactivé');
  const user = userEvent.setup();
  renderCard();
  const select = (await screen.findByLabelText('Modèle juge')) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe('m1'));
  await user.selectOptions(select, 'm2');
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('introuvable ou désactivé');
});
