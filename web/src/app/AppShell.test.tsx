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
  apiFetch.mockImplementation((path: string) =>
    Promise.resolve(path === '/api/scoring/todo' ? { items: [], count: 0 } : summary(0)),
  );
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
  expect(screen.getByRole('link', { name: 'Liens de partage' })).toHaveAttribute('href', '/admin/partages');
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
  expect(apiFetch).not.toHaveBeenCalledWith('/api/admin/errors/summary');
});

test('EXPLORER : « À noter » avec compteur des questions non terminées', async () => {
  apiFetch.mockImplementation((path: string) =>
    Promise.resolve(
      path === '/api/scoring/todo'
        ? {
            items: [
              { runTestId: 'q1', runId: 'r1', runName: 'S', testName: 'T1', answers: 3, scoredByMe: 1 },
              { runTestId: 'q2', runId: 'r1', runName: 'S', testName: 'T2', answers: 3, scoredByMe: 0 },
              { runTestId: 'q3', runId: 'r1', runName: 'S', testName: 'T3', answers: 2, scoredByMe: 2 },
            ],
            count: 3,
          }
        : summary(0),
    ),
  );
  renderShell('user');
  const link = await screen.findByRole('link', { name: /À noter/ });
  expect(link).toHaveAttribute('href', '/a-noter');
  expect(await within(link).findByLabelText('2 questions à noter')).toHaveTextContent('2');
});

test('EXPLORER : pas de badge « À noter » quand il n’y a rien à noter', async () => {
  renderShell('user');
  const link = await screen.findByRole('link', { name: 'À noter' });
  expect(within(link).queryByLabelText(/à noter/)).toBeNull();
});

test('EXPLORER : le compteur « À noter » est rafraîchi toutes les 60 s', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let items: unknown[] = [];
    apiFetch.mockImplementation((path: string) =>
      Promise.resolve(path === '/api/scoring/todo' ? { items, count: items.length } : summary(0)),
    );
    renderShell('user');
    const link = await screen.findByRole('link', { name: 'À noter' });
    expect(within(link).queryByLabelText(/à noter/)).toBeNull();
    items = [{ runTestId: 'q1', runId: 'r1', runName: 'S', testName: 'T', answers: 2, scoredByMe: 0 }];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await within(link).findByLabelText('1 question à noter')).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test('menu : Tableau de bord en tête, puis chaque section par ordre alphabétique', () => {
  renderShell('admin');
  const explore = ['Tableau de bord', 'À noter', 'Modèles', 'Séries'];
  const admin = ['Fournisseurs', 'Journal des erreurs', 'Liens de partage', 'Suites', 'Tests', 'Utilisateurs'];
  const links = [...explore, ...admin].map((name) => screen.getByRole('link', { name: new RegExp(`^${name}`) }));
  // Chaque lien précède le suivant dans le document : ordre attendu respecté, sections comprises.
  for (let i = 1; i < links.length; i++) {
    expect(links[i - 1]!.compareDocumentPosition(links[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
});

test('menu : chaque entrée a son icône « ? » avec une courte description, hors du lien', () => {
  renderShell('admin');
  for (const name of ['Tableau de bord', 'Séries', 'Modèles', 'À noter', 'Utilisateurs', 'Fournisseurs', 'Tests', 'Suites', 'Liens de partage', 'Journal des erreurs']) {
    const help = screen.getByRole('button', { name: `Aide : ${name}` });
    expect(help.closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    expect(help).toHaveAccessibleDescription(/\S{3,}/);
  }
  expect(screen.getByRole('button', { name: 'Aide : Suites' })).toHaveAccessibleDescription('Listes ordonnées de tests à lancer ensemble dans une série.');
});
