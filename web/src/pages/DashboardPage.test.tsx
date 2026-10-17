import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { AuthContext, type PublicUser, type Role } from '../auth/AuthProvider';
import { DashboardPage } from './DashboardPage';

vi.mock('../components/catalog/NewModelsCard', () => ({ NewModelsCard: () => <section data-testid="new-models" /> }));

function renderPage(role: Role) {
  const user: PublicUser = { id: 'u1', email: 'a@example.test', name: 'Laurent', role };
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthContext.Provider value={{ user, loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() }}>
        <DashboardPage />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

test('Utilisateur : aucun bloc vide entre le titre et la carte', () => {
  const { container } = renderPage('user');
  expect(container.querySelector('[data-testid="new-models"]')).toBeNull();
  expect(container.querySelector('div.mb-4')).toBeNull();
});

test('Admin : la carte des nouveautés est affichée', () => {
  const { container } = renderPage('admin');
  expect(container.querySelector('[data-testid="new-models"]')).not.toBeNull();
});
