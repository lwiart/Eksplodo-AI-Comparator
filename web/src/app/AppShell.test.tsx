import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { AuthContext, type PublicUser, type Role } from '../auth/AuthProvider';
import { AppShell } from './AppShell';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  apiFetch,
}));

const summary = (unresolvedGrave: number) => ({
  last24h: { total: 0, grave: 0 },
  last7d: { total: 0, grave: 0 },
  topOrigins: [],
  unresolvedGrave,
});

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(summary(0));
});
afterEach(() => localStorage.clear());

function renderShell(role: Role, logout = vi.fn().mockResolvedValue(undefined)) {
  const user: PublicUser = { id: 'u1', email: 'laurent@example.test', name: 'Laurent', role };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={{ user, loading: false, login: vi.fn(), logout, refresh: vi.fn() }}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<p>Contenu</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { logout };
}

test('Admin : section ADMIN visible', () => {
  renderShell('admin');
  expect(screen.getByText('ADMIN')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Utilisateurs' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Journal des erreurs' })).toBeInTheDocument();
});

test('Utilisateur : aucune entrée Admin', () => {
  renderShell('user');
  expect(screen.queryByText('ADMIN')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Utilisateurs' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Journal des erreurs' })).toBeNull();
});

test('logo et titre présents, entrée Tableau de bord', () => {
  renderShell('user');
  expect(screen.getByAltText('Eksplodo')).toBeInTheDocument();
  expect(screen.getByText('COMPARATEUR IA')).toBeInTheDocument();
  expect(screen.getByText('EXPLORER')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Tableau de bord' })).toBeInTheDocument();
  expect(screen.getByText('Contenu')).toBeInTheDocument();
});

test('EXPLORER : entrée Séries pour tous les rôles', () => {
  renderShell('user');
  expect(screen.getByRole('link', { name: 'Séries' })).toHaveAttribute('href', '/series');
});

test('menu du compte : Mon compte, Animations, Déconnexion', async () => {
  const { logout } = renderShell('user');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Laurent/ }));
  expect(screen.getByRole('menuitem', { name: 'Mon compte' })).toBeInTheDocument();

  const animations = screen.getByRole('menuitemcheckbox', { name: 'Animations' });
  expect(animations).toBeChecked();
  await user.click(animations);
  expect(localStorage.getItem('aic.animations')).toBe('off');
  expect(document.documentElement.dataset.animations).toBe('off');

  // Le menu reste ouvert après le réglage : on peut enchaîner avec la déconnexion.
  await user.click(screen.getByRole('menuitem', { name: 'Déconnexion' }));
  expect(logout).toHaveBeenCalledOnce();
});

test('sous 800 px, le menu s’ouvre dans un tiroir', async () => {
  renderShell('admin');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Ouvrir le menu' }));
  const drawer = screen.getByRole('dialog', { name: 'Menu' });
  expect(drawer).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Fermer le menu' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('déconnexion en échec : message visible, pas de rejet non géré', async () => {
  const logout = vi.fn().mockRejectedValue(new ApiError('network', 0, 'Serveur injoignable'));
  renderShell('user', logout);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Laurent/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Déconnexion' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Le serveur ne répond pas');
});

test('Admin : compteur des erreurs graves non traitées à côté du journal', async () => {
  apiFetch.mockResolvedValue(summary(3));
  renderShell('admin');
  const link = await screen.findByRole('link', { name: /Journal des erreurs/ });
  expect(await within(link).findByText('3')).toBeInTheDocument();
  expect(apiFetch).toHaveBeenCalledWith('/api/admin/errors/summary');
});

test('Admin : aucun compteur quand il n’y a pas d’erreur grave non traitée', async () => {
  renderShell('admin');
  await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
  expect(screen.getByRole('link', { name: 'Journal des erreurs' })).toBeInTheDocument();
});

test('Utilisateur : aucun appel au résumé des erreurs', () => {
  renderShell('user');
  expect(apiFetch).not.toHaveBeenCalled();
});
