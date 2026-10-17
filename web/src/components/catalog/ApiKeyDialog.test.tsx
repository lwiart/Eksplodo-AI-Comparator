import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiKeyDialog } from './ApiKeyDialog';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));

const KEY = 'rq-test-0123456789wxyz';
beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ provider: { id: 'p1' } });
});
afterEach(() => vi.clearAllMocks());

function renderDialog(onOpenChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ApiKeyDialog providerId="p1" providerName="Anthropic" hasKey open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

test('PATCH { apiKey }, champ vidé après enregistrement, la clé n’est jamais réaffichée', async () => {
  const user = userEvent.setup();
  const onOpenChange = renderDialog();
  const input = screen.getByLabelText('Clé API');
  expect(input).toHaveAttribute('type', 'password');
  await user.type(input, KEY);
  await user.click(screen.getByRole('button', { name: 'Afficher' }));
  expect(input).toHaveAttribute('type', 'text');
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(apiFetch).toHaveBeenCalledWith('/api/providers/p1', { method: 'PATCH', body: { apiKey: KEY } });
  expect(screen.queryByDisplayValue(/rq-test/)).toBeNull();
  expect(document.body.textContent).not.toContain(KEY);
});

test('Supprimer la clé demande confirmation puis envoie apiKey: null', async () => {
  const user = userEvent.setup();
  renderDialog();
  await user.click(screen.getByRole('button', { name: 'Supprimer la clé' }));
  expect(apiFetch).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Confirmer la suppression' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/providers/p1', { method: 'PATCH', body: { apiKey: null } }));
});

test('clé mal formée : le message précis du serveur est affiché', async () => {
  const user = userEvent.setup();
  const message = 'Clé API invalide : 8 à 500 caractères imprimables, sans espace';
  apiFetch.mockRejectedValue(Object.assign(new Error(message), { code: 'validation', status: 400 }));
  renderDialog();
  await user.type(screen.getByLabelText('Clé API'), KEY);
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
});

test('une erreur du serveur est affichée et la saisie est effacée', async () => {
  const user = userEvent.setup();
  apiFetch.mockRejectedValue(Object.assign(new Error('x'), { code: 'validation', status: 400 }));
  renderDialog();
  await user.type(screen.getByLabelText('Clé API'), KEY);
  await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/invalides/);
  expect(screen.queryByDisplayValue(/rq-test/)).toBeNull();
});
