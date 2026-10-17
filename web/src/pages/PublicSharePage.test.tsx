import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PublicModel, PublicShare } from '../api/public-share';
import { RootRoutes } from '../app/RootRoutes';
import { MODELS } from '../components/results/ranking.fixtures';

vi.mock('recharts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) => cloneElement(children, { width: 600, height: 280 }),
}));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

// Rang et score global du serveur (volontairement différents d'un recalcul) : la page doit les afficher tels quels.
const SERVER: [number | null, number | null][] = [[1, 8.43], [2, 7.11], [3, 5.5], [null, null]];
const models: PublicModel[] = MODELS.map((m, i) => ({ ...m, modelId: `m${i + 1}`, rank: SERVER[i]![0], global: SERVER[i]![1] }));

const SHARE: PublicShare = {
  title: 'Quelle IA pour vos réponses ?',
  intro: 'Première ligne\nSeconde ligne',
  auditUrl: 'https://eksplodo.fr',
  showCosts: true,
  run: { name: 'Série', completedAt: '2026-10-15T10:00:00.000Z', modelCount: 4, testCount: 2, repetitions: 1, judgeName: 'Claude Juge', totalCostUsd: 1.2345 },
  weights: { quality: 50, speed: 20, cost: 20, reliability: 10 },
  categories: ['Rédaction', 'Logique'],
  models,
  verdicts: [
    { label: 'Meilleur compromis', text: 'Rapide et précis.', model: { key: 'm1', name: 'Alpha', color: '#F0631F' } },
    { label: 'À retenir', text: 'Un message sans modèle.', model: null },
  ],
  responses: null,
};

function mockFetch(share: PublicShare | { status: number }) {
  const fn = vi.fn().mockImplementation(async () =>
    'status' in share
      ? new Response(JSON.stringify({ error: { code: 'x', message: 'x' } }), { status: share.status })
      : new Response(JSON.stringify(share), { status: 200 }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/p/jeton123']}>
        <RootRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test('page publique : titre, verdicts, podium, graphes et classement ; seule GET /share/:token est appelée ; aucun lien vers l’application', async () => {
  const fetchSpy = mockFetch(SHARE);
  renderPage();
  expect(await screen.findByRole('heading', { level: 1, name: SHARE.title })).toBeInTheDocument();
  expect(screen.getByText(/Première ligne/)).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Verdicts' })).getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByRole('list', { name: 'Podium' })).toBeInTheDocument();
  expect(screen.getByTestId('quality-speed-chart')).toBeInTheDocument();
  expect(screen.getByTestId('category-chart')).toBeInTheDocument();
  // Rang et score global du serveur, pas un recalcul.
  const table = within(screen.getByRole('table', { name: 'Classement détaillé' }));
  expect(table.getByText('8,43')).toBeInTheDocument();
  expect(table.getByText('7,11')).toBeInTheDocument();

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy.mock.calls[0]![0]).toBe('/share/jeton123');
  expect(fetchSpy.mock.calls.some(([url]) => String(url).startsWith('/api'))).toBe(false);

  const audit = screen.getAllByRole('link', { name: 'Audit gratuit' });
  for (const a of audit) {
    expect(a).toHaveAttribute('href', 'https://eksplodo.fr');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  }
  // Aucun lien interne (menu, connexion…).
  for (const a of screen.getAllByRole('link')) expect(a.getAttribute('href')).toMatch(/^https:\/\//);
});

test('showCosts faux : pas de colonne coût ni de montant affiché', async () => {
  mockFetch({ ...SHARE, showCosts: false, run: { ...SHARE.run, totalCostUsd: null }, models: models.map((m) => ({ ...m, cost: null, raw: { ...m.raw, meanCostUsd: null } })) });
  renderPage();
  await screen.findByRole('heading', { level: 1, name: SHARE.title });
  expect(screen.queryByRole('columnheader', { name: 'Coût moyen' })).not.toBeInTheDocument();
  expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
});

test('réponses affichées seulement si responses est non nul ; Markdown sans HTML', async () => {
  mockFetch(SHARE);
  renderPage();
  await screen.findByRole('heading', { level: 1, name: SHARE.title });
  expect(screen.queryByRole('region', { name: 'Réponses des modèles' })).not.toBeInTheDocument();
});

test('réponses publiées : sélecteur de test et Markdown assaini', async () => {
  mockFetch({
    ...SHARE,
    responses: [
      { testName: 'Rédaction 1', category: 'Rédaction', userPrompt: 'Écris', answers: [{ modelKey: 'm1', repetition: 1, text: '**Gras** <script>alert(1)</script>', finalScore: 9, judgeRationale: 'Clair' }] },
      { testName: 'Logique 1', category: 'Logique', userPrompt: 'Raisonne', answers: [{ modelKey: 'm2', repetition: 1, text: 'Autre réponse', finalScore: 7, judgeRationale: null }] },
    ],
  });
  renderPage();
  const region = await screen.findByRole('region', { name: 'Réponses des modèles' });
  expect(within(region).getByText('Gras').tagName).toBe('STRONG');
  expect(region.querySelector('script')).toBeNull();
  expect(within(region).getByText('Clair')).toBeInTheDocument();
  await userEvent.setup().selectOptions(within(region).getByRole('combobox', { name: 'Test' }), 'Logique 1');
  expect(within(region).getByText('Autre réponse')).toBeInTheDocument();
  expect(within(region).queryByText('Clair')).not.toBeInTheDocument();
});

test('lien inconnu : message dédié, pas de redirection vers /connexion', async () => {
  const fetchSpy = mockFetch({ status: 404 });
  renderPage();
  expect(await screen.findByRole('heading', { name: "Ce lien n'existe pas ou a été désactivé" })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Connexion' })).not.toBeInTheDocument();
  expect(screen.queryAllByRole('link')).toHaveLength(0);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test('limite de débit : message dédié', async () => {
  mockFetch({ status: 429 });
  renderPage();
  expect(await screen.findByRole('heading', { name: 'Trop de consultations, réessayez dans une minute' })).toBeInTheDocument();
});

test('verdict sans modèle : libellé et texte seuls', async () => {
  mockFetch(SHARE);
  renderPage();
  const item = (await screen.findByText('Un message sans modèle.')).closest('li')!;
  expect(within(item).getByText('À retenir')).toBeInTheDocument();
  expect(item.querySelector('strong')).toBeNull();
  await waitFor(() => expect(document.title).toContain(SHARE.title));
});
