import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { UsersPage } from './UsersPage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));

const USERS = [
  { id: 'u1', email: 'admin@example.test', name: 'Alice Admin', role: 'admin', status: 'active', lastLoginAt: '2026-10-15T08:00:00.000Z', createdAt: '2026-10-01T08:00:00.000Z' },
  { id: 'u2', email: 'bob@example.test', name: 'Bob Invité', role: 'user', status: 'invited', lastLoginAt: null, createdAt: '2026-10-10T08:00:00.000Z' },
  { id: 'u3', email: 'carla@example.test', name: 'Carla Off', role: 'user', status: 'disabled', lastLoginAt: null, createdAt: '2026-10-11T08:00:00.000Z' },
];
const LINK = { link: 'http://localhost:5173/invitation/jeton123', expiresAt: '2026-10-19T08:00:00.000Z', mail: 'not_configured' };

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path === '/api/users' && !init?.method) return Promise.resolve({ users: USERS });
    if (path === '/api/users' && init?.method === 'POST') return Promise.resolve({ user: USERS[1], ...LINK });
    if (path.endsWith('/invite-link') || path.endsWith('/reset-link')) return Promise.resolve(LINK);
    if (init?.method === 'PATCH') return Promise.resolve({ user: USERS[1] });
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});
afterEach(() => vi.clearAllMocks());

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UsersPage />
    </QueryClientProvider>,
  );
  return client;
}

const rowOf = (name: string) => within(screen.getByRole('row', { name: new RegExp(name) }));

async function invite() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Inviter' }));
  await user.type(screen.getByLabelText('Nom'), 'Bob Invité');
  await user.type(screen.getByLabelText('E-mail'), 'bob@example.test');
  await user.click(screen.getByRole('button', { name: 'Envoyer l’invitation' }));
  return user;
}

test('inviter : le lien s’affiche une fois avec un bouton Copier et l’état de l’e-mail', async () => {
  renderPage();
  await invite();
  expect(await screen.findByDisplayValue(/\/invitation\//)).toBeInTheDocument();
  expect(screen.getByText(/e-mail non envoyé.*SMTP/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copier' })).toBeInTheDocument();
  expect(screen.getByText('Ce lien ne sera plus affiché : copiez-le maintenant.')).toBeInTheDocument();
  expect(apiFetch).toHaveBeenCalledWith('/api/users', { method: 'POST', body: { email: 'bob@example.test', name: 'Bob Invité', role: 'user' } });
});

test('fermer la fenêtre fait disparaître le lien', async () => {
  renderPage();
  const user = await invite();
  await screen.findByDisplayValue(/\/invitation\//);
  await user.click(screen.getByRole('button', { name: 'Fermer' }));
  expect(screen.queryByDisplayValue(/\/invitation\//)).toBeNull();
});

test('le lien ne survit pas à sa fenêtre : ni dans le DOM, ni en mémoire, et une nouvelle action n’affiche que le nouveau lien', async () => {
  let n = 0;
  apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
    if (path.endsWith('/invite-link')) return Promise.resolve({ ...LINK, link: `http://localhost:5173/invitation/jeton-${++n}` });
    return Promise.resolve({ users: USERS });
  });
  const client = renderPage();
  const user = userEvent.setup();
  await screen.findByText('Bob Invité');
  await user.click(rowOf('Bob Invité').getByRole('button', { name: /Régénérer le lien/ }));
  expect(await screen.findByDisplayValue(/jeton-1/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Fermer' }));
  expect(screen.queryByDisplayValue(/jeton-1/)).toBeNull();
  await waitFor(() => {
    const kept = client.getMutationCache().getAll().some((m) => JSON.stringify(m.state.data ?? null).includes('jeton-1'));
    expect(kept).toBe(false);
  });
  await user.click(rowOf('Bob Invité').getByRole('button', { name: /Régénérer le lien/ }));
  expect(await screen.findByDisplayValue(/jeton-2/)).toBeInTheDocument();
  expect(screen.queryByDisplayValue(/jeton-1/)).toBeNull();
});

test('Annuler referme la fenêtre d’invitation et vide le formulaire', async () => {
  renderPage();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Inviter' }));
  await user.type(screen.getByLabelText('Nom'), 'Dora');
  await user.type(screen.getByLabelText('E-mail'), 'dora@example.test');
  await user.click(screen.getByRole('button', { name: 'Annuler' }));
  await user.click(screen.getByRole('button', { name: 'Inviter' }));
  expect(screen.getByLabelText('Nom')).toHaveValue('');
  expect(screen.getByLabelText('E-mail')).toHaveValue('');
});

test('e-mail déjà utilisé : message français dans la fenêtre', async () => {
  apiFetch.mockImplementation((path: string, init?: { method?: string }) =>
    init?.method === 'POST' ? Promise.reject(new ApiError('email_taken', 409, 'x')) : Promise.resolve({ users: USERS }),
  );
  renderPage();
  await invite();
  expect(await screen.findByRole('alert')).toHaveTextContent(/existe déjà/i);
});

test('compte invité : « Régénérer le lien » ; compte actif : « Lien de réinitialisation »', async () => {
  renderPage();
  await screen.findByText('Bob Invité');
  expect(rowOf('Bob Invité').getByRole('button', { name: /Régénérer le lien/ })).toBeInTheDocument();
  expect(rowOf('Bob Invité').queryByRole('button', { name: /Lien de réinitialisation/ })).toBeNull();
  expect(rowOf('Alice Admin').getByRole('button', { name: /Lien de réinitialisation/ })).toBeInTheDocument();
  expect(rowOf('Alice Admin').queryByRole('button', { name: /Régénérer le lien/ })).toBeNull();

  const user = userEvent.setup();
  await user.click(rowOf('Bob Invité').getByRole('button', { name: /Régénérer le lien/ }));
  expect(await screen.findByDisplayValue(/\/invitation\//)).toBeInTheDocument();
  expect(apiFetch).toHaveBeenCalledWith('/api/users/u2/invite-link', { method: 'POST' });
});

test('lien de réinitialisation d’un compte actif', async () => {
  renderPage();
  const user = userEvent.setup();
  await screen.findByText('Alice Admin');
  await user.click(rowOf('Alice Admin').getByRole('button', { name: /Lien de réinitialisation/ }));
  await screen.findByDisplayValue(/\/invitation\//);
  expect(apiFetch).toHaveBeenCalledWith('/api/users/u1/reset-link', { method: 'POST' });
});

test('erreur last_admin affichée en français', async () => {
  apiFetch.mockImplementation((path: string, init?: { method?: string }) =>
    init?.method === 'PATCH' ? Promise.reject(new ApiError('last_admin', 409, 'x')) : Promise.resolve({ users: USERS }),
  );
  renderPage();
  const user = userEvent.setup();
  await screen.findByText('Alice Admin');
  await user.click(rowOf('Alice Admin').getByRole('button', { name: /Désactiver/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/dernier Admin/i);
});

test('désactiver, réactiver et changer le rôle envoient le bon PATCH', async () => {
  renderPage();
  const user = userEvent.setup();
  await screen.findByText('Bob Invité');
  await user.click(rowOf('Carla Off').getByRole('button', { name: /Réactiver/ }));
  expect(apiFetch).toHaveBeenCalledWith('/api/users/u3', { method: 'PATCH', body: { status: 'active' } });
  await user.click(rowOf('Bob Invité').getByRole('button', { name: /Passer Admin/ }));
  expect(apiFetch).toHaveBeenCalledWith('/api/users/u2', { method: 'PATCH', body: { role: 'admin' } });
  await user.click(rowOf('Alice Admin').getByRole('button', { name: /Passer Utilisateur/ }));
  expect(apiFetch).toHaveBeenCalledWith('/api/users/u1', { method: 'PATCH', body: { role: 'user' } });
});

test('pastilles de statut : Invité, Actif, Désactivé', async () => {
  renderPage();
  await screen.findByText('Bob Invité');
  expect(rowOf('Bob Invité').getByText('Invité')).toBeInTheDocument();
  expect(rowOf('Alice Admin').getByText('Actif')).toBeInTheDocument();
  expect(rowOf('Carla Off').getByText('Désactivé')).toBeInTheDocument();
});
