import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PublicProvider } from '../../api/catalog';
import { ProviderDialog } from './ProviderDialog';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));

const PROVIDER: PublicProvider = {
  id: 'p1', name: 'Requesty', type: 'openai_compatible', baseUrl: 'https://router.requesty.ai/v1', maxConcurrency: 2,
  enabled: true, keyState: 'stored', keyLast4: 'wxyz', usable: true, fake: false, modelCount: 0,
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ provider: PROVIDER });
});
afterEach(() => vi.clearAllMocks());

function renderDialog(provider?: PublicProvider) {
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ProviderDialog provider={provider} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

test('modification : avertit que changer l’hôte efface la clé', () => {
  renderDialog(PROVIDER);
  expect(screen.getByText('Changer l’hôte de l’URL efface la clé enregistrée : ressaisissez-la.')).toBeInTheDocument();
});

test('modification : seuls les champs modifiés sont envoyés', async () => {
  const user = userEvent.setup();
  renderDialog(PROVIDER);
  const name = screen.getByLabelText('Nom');
  await user.clear(name);
  await user.type(name, 'Requesty 2');
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  expect(apiFetch).toHaveBeenCalledWith('/api/providers/p1', { method: 'PATCH', body: { name: 'Requesty 2' } });
});

test('modification sans changement : aucune requête, la fenêtre se ferme', async () => {
  const user = userEvent.setup();
  const onOpenChange = renderDialog(PROVIDER);
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(apiFetch).not.toHaveBeenCalled();
});

test('création avec clé mal formée : le message précis du serveur est affiché', async () => {
  const user = userEvent.setup();
  const message = 'Clé API invalide : 8 à 500 caractères imprimables, sans espace';
  apiFetch.mockRejectedValue(Object.assign(new Error(message), { code: 'validation', status: 400 }));
  renderDialog();
  await user.type(screen.getByLabelText('Nom'), 'Nouveau');
  await user.type(screen.getByLabelText('URL de base'), 'https://x.test/v1');
  await user.type(screen.getByLabelText('Clé API (facultative)'), 'abc');
  await user.click(screen.getByRole('button', { name: 'Ajouter' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
});
