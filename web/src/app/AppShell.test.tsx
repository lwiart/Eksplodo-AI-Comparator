import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthContext, type PublicUser, type Role } from '../auth/AuthProvider';
import { AppShell } from './AppShell';

afterEach(() => localStorage.clear());

function renderShell(role: Role, logout = vi.fn().mockResolvedValue(undefined)) {
  const user: PublicUser = { id: 'u1', email: 'laurent@example.test', name: 'Laurent', role };
  render(
    <AuthContext.Provider value={{ user, loading: false, login: vi.fn(), logout, refresh: vi.fn() }}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<p>Contenu</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
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
