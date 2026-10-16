import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthContext, type AuthValue } from '../auth/AuthProvider';
import { InvitationPage } from './InvitationPage';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const value: AuthValue = { user: null, loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthContext.Provider value={value}>
        <MemoryRouter initialEntries={['/invitation/jeton']}>
          <Routes>
            <Route path="/invitation/:token" element={<InvitationPage />} />
            <Route path="/connexion" element={<p>Page de connexion</p>} />
            <Route path="/" element={<p>Tableau de bord</p>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return value;
}

async function submit(password: string, confirm = password) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Nom'), 'Alice');
  await user.type(screen.getByLabelText('Mot de passe'), password);
  await user.type(screen.getByLabelText('Confirmer le mot de passe'), confirm);
  await user.click(screen.getByRole('button', { name: 'Activer mon compte' }));
}

test('mot de passe de moins de 12 caractères : erreur avant envoi', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  setup();
  await submit('court');
  expect(await screen.findByRole('alert')).toHaveTextContent(/12 caractères/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('confirmation différente : erreur avant envoi', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  setup();
  await submit('un-mot-de-passe-long', 'un-autre-mot-de-passe');
  expect(await screen.findByRole('alert')).toHaveTextContent(/ne correspondent pas/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('lien invalide → message « Ce lien n’est plus valable » et lien vers la connexion', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      async () => new Response(JSON.stringify({ error: { code: 'invitation_invalid', message: 'x' } }), { status: 400 }),
    ),
  );
  setup();
  await submit('un-mot-de-passe-long');
  expect(await screen.findByText(/Ce lien n’est plus valable/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Retour à la connexion' })).toHaveAttribute('href', '/connexion');
});

test('invitation acceptée → session rafraîchie puis tableau de bord', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => new Response(JSON.stringify({ user: { id: 'u' } }), { status: 200 })),
  );
  const auth = setup();
  await submit('un-mot-de-passe-long');
  expect(await screen.findByText('Tableau de bord')).toBeInTheDocument();
  expect(auth.refresh).toHaveBeenCalled();
});
