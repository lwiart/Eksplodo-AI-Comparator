import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import { AuthContext, type PublicUser, type Role } from '../auth/AuthProvider';
import { DEFINITIONS } from '../components/results/definitions';
import { HelpPage } from './HelpPage';

function renderHelp(role: Role) {
  const user: PublicUser = { id: 'u1', email: 'a@example.test', name: 'Laurent', role };
  render(
    <AuthContext.Provider value={{ user, loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() }}>
      <MemoryRouter>
        <HelpPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

test('Admin : sommaire complet, sections Admin signalées, définitions des scores reprises', () => {
  renderHelp('admin');
  expect(screen.getByRole('heading', { level: 1, name: 'Aide' })).toBeInTheDocument();
  const toc = within(screen.getByRole('navigation', { name: 'Sommaire de l’aide' }));
  expect(toc.getByRole('link', { name: 'Premiers pas' })).toHaveAttribute('href', '#premiers-pas');
  expect(toc.getByRole('link', { name: 'Lancer une série' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: /Lancer une série/ })).toHaveTextContent('Admin');
  expect(screen.getByText(DEFINITIONS.quality)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Fournisseurs' })).toHaveAttribute('href', '/admin/fournisseurs');
});

test('Utilisateur : sans les sections réservées aux Admins', () => {
  renderHelp('user');
  expect(screen.queryByRole('heading', { level: 2, name: /Premiers pas/ })).toBeNull();
  expect(screen.queryByRole('heading', { level: 2, name: /Administration/ })).toBeNull();
  expect(screen.getByRole('heading', { level: 2, name: 'Méthodes de notation' })).toBeInTheDocument();
  expect(screen.getByText(/réservées aux Admins/)).toBeInTheDocument();
});
