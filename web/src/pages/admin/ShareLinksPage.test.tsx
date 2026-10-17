import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import { ShareLinksPage } from './ShareLinksPage';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch,
}));

const NEW_TOKEN = 'b'.repeat(32);
const make = (over: Record<string, unknown>) => ({
  id: 'l1',
  runId: 'r1',
  runName: 'Polyvalence octobre',
  title: 'Comparatif clients',
  intro: 'Bonjour',
  verdicts: [{ label: 'Meilleur compromis', modelId: 'm1', text: 'Texte' }],
  showCosts: true,
  showResponses: false,
  active: true,
  viewCount: 42,
  createdAt: '2026-10-17T12:00:00.000Z',
  updatedAt: '2026-10-17T12:00:00.000Z',
  ...over,
});

let links: ReturnType<typeof make>[];
beforeEach(() => {
  links = [make({}), make({ id: 'l2', title: 'Ancien lien', active: false, viewCount: 3 })];
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: { method?: string; body?: Record<string, unknown> }) => {
    if (path === '/api/settings/sharing') return Promise.resolve({ auditUrl: 'https://eksplodo.fr' });
    if (path === '/api/share-links' && !init?.method) return Promise.resolve({ links });
    if (path === '/api/share-links/l1' && init?.method === 'PATCH') {
      links = links.map((l) => (l.id === 'l1' ? { ...l, active: init.body!.active as boolean } : l));
      return Promise.resolve({ link: links[0] });
    }
    if (path === '/api/share-links/l1/regenerate') return Promise.resolve({ link: links[0], token: NEW_TOKEN });
    if (path === '/api/share-links/l2' && init?.method === 'DELETE') {
      links = links.filter((l) => l.id !== 'l2');
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error(`appel inattendu ${path}`));
  });
});

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ShareLinksPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rowOf = async (title: string) => within((await screen.findByText(title)).closest('tr')!);

test('liste : désactiver, régénérer (confirmation, nouveau lien), supprimer (confirmation) ; compteur de vues affiché', async () => {
  const user = userEvent.setup();
  renderPage();
  const first = await rowOf('Comparatif clients');
  expect(first.getByText('42')).toBeInTheDocument();
  expect(first.getByText('Actif')).toBeInTheDocument();
  expect((await rowOf('Ancien lien')).getByText('Désactivé')).toBeInTheDocument();
  expect((await rowOf('Ancien lien')).getByRole('button', { name: /Réactiver/ })).toBeInTheDocument();
  expect(await screen.findByLabelText('URL de destination')).toBeInTheDocument();

  // Désactiver : le PATCH envoie le corps complet avec `active: false`.
  await user.click(first.getByRole('button', { name: /^Désactiver/ }));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/api/share-links/l1', {
      method: 'PATCH',
      body: { title: 'Comparatif clients', intro: 'Bonjour', verdicts: links[0]!.verdicts, showCosts: true, showResponses: false, active: false },
    }),
  );
  await waitFor(async () => expect((await rowOf('Comparatif clients')).getByText('Désactivé')).toBeInTheDocument());

  // Régénérer : rien n'est envoyé avant la confirmation, puis le nouveau lien est affiché.
  await user.click((await rowOf('Comparatif clients')).getByRole('button', { name: /Régénérer le lien/ }));
  const confirm = within(await screen.findByRole('dialog', { name: 'Régénérer ce lien ?' }));
  expect(apiFetch.mock.calls.some((c) => String(c[0]).endsWith('/regenerate'))).toBe(false);
  await user.click(confirm.getByRole('button', { name: 'Régénérer le lien' }));
  const shown = within(await screen.findByRole('dialog', { name: 'Nouveau lien de partage' }));
  expect((shown.getByLabelText('Lien de la page publique') as HTMLInputElement).value).toBe(`${location.origin}/p/${NEW_TOKEN}`);
  expect(shown.getByRole('button', { name: 'Copier' })).toBeInTheDocument();
  await user.click(shown.getByRole('button', { name: 'Fermer' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  // Supprimer : confirmation d'abord.
  await user.click((await rowOf('Ancien lien')).getByRole('button', { name: /Supprimer/ }));
  const ask = within(await screen.findByRole('dialog', { name: 'Supprimer ce lien ?' }));
  expect(apiFetch.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(false);
  await user.click(ask.getByRole('button', { name: 'Supprimer le lien' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/share-links/l2', { method: 'DELETE' }));
  await waitFor(() => expect(screen.queryByText('Ancien lien')).toBeNull());
});
