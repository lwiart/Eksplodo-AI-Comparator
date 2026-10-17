import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthProvider, type PublicUser } from '../auth/AuthProvider';
import { AppRoutes } from './routes';

afterEach(() => vi.unstubAllGlobals());

function stubMe(user: PublicUser | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () =>
      user
        ? new Response(JSON.stringify({ user }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'x' } }), { status: 401 }),
    ),
  );
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const USER: PublicUser = { id: 'u1', email: 'a@example.test', name: 'Alice', role: 'user' };
const ADMIN: PublicUser = { id: 'u2', email: 'b@example.test', name: 'Bob', role: 'admin' };

test('non connecté → redirigé vers /connexion', async () => {
  stubMe(null);
  renderAt('/compte');
  expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
});

test('les pages publiques restent accessibles sans session', async () => {
  stubMe(null);
  renderAt('/invitation/abc');
  expect(await screen.findByRole('heading', { name: 'Activer mon compte' })).toBeInTheDocument();
});

test('connecté → tableau de bord avec « Bonjour {nom} »', async () => {
  stubMe(USER);
  renderAt('/');
  expect(await screen.findByRole('heading', { name: 'Bonjour Alice' })).toBeInTheDocument();
  expect(screen.getByText('Les séries et les classements arriveront ici.')).toBeInTheDocument();
});

test('Utilisateur sur /admin/utilisateurs → page « Accès refusé »', async () => {
  stubMe(USER);
  renderAt('/admin/utilisateurs');
  expect(await screen.findByRole('heading', { name: 'Accès refusé' })).toBeInTheDocument();
});

test('Admin sur /admin/utilisateurs → page d’administration', async () => {
  stubMe(ADMIN);
  renderAt('/admin/utilisateurs');
  expect(await screen.findByRole('heading', { name: 'Utilisateurs' })).toBeInTheDocument();
  expect(screen.queryByText('Accès refusé')).toBeNull();
});

test('Utilisateur sur /admin/fournisseurs → « Accès refusé », réglage du juge par défaut jamais lu', async () => {
  stubMe(USER);
  renderAt('/admin/fournisseurs');
  expect(await screen.findByRole('heading', { name: 'Accès refusé' })).toBeInTheDocument();
  const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
  expect(urls.some((u) => u.includes('/api/settings/scoring'))).toBe(false);
});
