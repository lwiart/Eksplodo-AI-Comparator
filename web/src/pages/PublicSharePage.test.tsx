import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PublicModel, PublicShare } from '../api/public-share';
import { RootRoutes } from '../app/RootRoutes';
import { DEFINITIONS } from '../components/results/definitions';
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
const SERVER: [number | null, number | null][] = [[1, 84.3], [2, 71.1], [3, 55], [null, null]];
const models: PublicModel[] = MODELS.map((m, i) => ({ ...m, modelId: `m${i + 1}`, rank: SERVER[i]![0], global: SERVER[i]![1] }));

/** Détail de test publié avec les réponses (fenêtre « détail »). */
const DETAIL = { tags: [], systemPrompt: null, temperature: 0.7, maxTokens: 1000, scoringMethod: 'judge' as const, scoringConfig: { criteria: 'Clarté et justesse.' }, attachments: [] };

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
  return render(
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
  // Matrice par catégorie : tous les modèles notés, dans l'ordre du serveur, sous le nuage et sur toute la largeur.
  const matrix = screen.getByRole('table', { name: 'Qualité par catégorie de test' });
  expect(within(matrix).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['AlphaAnthropic', 'BravoOpenAI', 'CharlieMistral']);
  const scatterCard = screen.getByTestId('quality-speed-chart').parentElement!;
  const heatmapCard = screen.getByRole('heading', { level: 2, name: 'Qualité par catégorie de test note moyenne sur 100' }).parentElement!;
  expect(heatmapCard).toContainElement(matrix);
  expect(scatterCard.parentElement).toBe(heatmapCard.parentElement);
  expect(heatmapCard.parentElement).toHaveClass('flex', 'flex-col');
  expect(heatmapCard.parentElement!.querySelector('.lg\\:grid-cols-2')).toBeNull();
  expect(screen.getByRole('heading', { level: 2, name: 'Qualité par catégorie de test note moyenne sur 100' })).toBeInTheDocument();
  expect(screen.getByTestId('quality-speed-chart').textContent).toContain('Qualité (note sur 100)');
  // Rang et score global du serveur, pas un recalcul.
  const table = within(screen.getByRole('table', { name: 'Classement détaillé' }));
  expect(table.getByText('84')).toBeInTheDocument();
  expect(table.getByText('71')).toBeInTheDocument();
  // Aides sur les en-têtes ; à l'impression, le bloc « Définitions » les remplace.
  expect(table.getByRole('button', { name: 'Aide : Qualité' })).toHaveAccessibleDescription(DEFINITIONS.quality);
  expect(table.getByRole('button', { name: 'Aide : Fiabilité' })).toHaveAccessibleDescription(DEFINITIONS.reliability);
  const definitions = screen.getByRole('region', { name: 'Définitions' });
  expect(definitions).toHaveClass('print-only');
  expect(within(definitions).getByText(DEFINITIONS.cost)).toBeInTheDocument();

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

test('showCosts faux : pas de colonne coût ni de montant affiché, même si la réponse contient des coûts', async () => {
  // Défense en profondeur : les coûts sont présents (non nuls) dans les données, la page ne doit rien en montrer.
  mockFetch({ ...SHARE, showCosts: false, run: { ...SHARE.run, totalCostUsd: 9.87 } });
  renderPage();
  await screen.findByRole('heading', { level: 1, name: SHARE.title });
  expect(screen.queryByRole('columnheader', { name: 'Coût moyen' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Aide : Coût' })).not.toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Définitions' })).queryByText(DEFINITIONS.cost)).not.toBeInTheDocument();
  expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  expect(screen.queryByText(/coût total/i)).not.toBeInTheDocument();
});

test('showCosts vrai : coût total affiché', async () => {
  mockFetch(SHARE);
  renderPage();
  expect(await screen.findByText(/coût total de la série/)).toBeInTheDocument();
});

test('auditUrl non https : aucun bouton « Audit gratuit »', async () => {
  mockFetch({ ...SHARE, auditUrl: 'javascript:alert(1)' });
  renderPage();
  await screen.findByRole('heading', { level: 1, name: SHARE.title });
  expect(screen.queryByRole('link', { name: 'Audit gratuit' })).not.toBeInTheDocument();
  expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
});

test('« Version imprimable » appelle window.print ; la gerbe porte no-print et le podium statique print-only', async () => {
  mockFetch(SHARE);
  const print = vi.fn();
  vi.stubGlobal('print', print);
  renderPage();
  await screen.findByRole('heading', { level: 1, name: SHARE.title });
  await userEvent.setup().click(screen.getByRole('button', { name: 'Version imprimable' }));
  expect(print).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Version imprimable' }).closest('.no-print')).not.toBeNull();
  expect(screen.getByTestId('fanout-fallback').closest('.no-print')).not.toBeNull();
  expect(screen.getByRole('list', { name: 'Podium', hidden: true }).closest('.no-print')).not.toBeNull();
  expect(screen.getByRole('list', { name: 'Podium imprimable', hidden: true }).closest('.print-only')).not.toBeNull();
});

test('le titre du document est restauré au démontage', async () => {
  mockFetch(SHARE);
  document.title = 'Avant';
  const { unmount } = renderPage();
  await waitFor(() => expect(document.title).toContain(SHARE.title));
  unmount();
  expect(document.title).toBe('Avant');
});

test('réponses affichées seulement si responses est non nul', async () => {
  mockFetch(SHARE);
  renderPage();
  await screen.findByRole('heading', { level: 1, name: SHARE.title });
  expect(screen.queryByRole('region', { name: 'Réponses des modèles' })).not.toBeInTheDocument();
});

test('réponses publiées : sélecteur de test et Markdown assaini', async () => {
  mockFetch({
    ...SHARE,
    responses: [
      { testName: 'Rédaction 1', category: 'Rédaction', userPrompt: 'Écris', detail: DETAIL, answers: [{ modelKey: 'm1', repetition: 1, text: '**Gras** <script>alert(1)</script>', finalScore: 9, judgeRationale: 'Clair' }] },
      { testName: 'Logique 1', category: 'Logique', userPrompt: 'Raisonne', detail: DETAIL, answers: [{ modelKey: 'm2', repetition: 1, text: 'Autre réponse', finalScore: 7, judgeRationale: null }] },
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

test('série non terminée : badge « Résultats provisoires » ; absent d’une série terminée', async () => {
  mockFetch({ ...SHARE, run: { ...SHARE.run, completedAt: null } });
  const { unmount } = renderPage();
  expect(await screen.findByText('Résultats provisoires')).toBeInTheDocument();
  unmount();
  mockFetch(SHARE);
  renderPage();
  await screen.findByRole('heading', { level: 1, name: SHARE.title });
  expect(screen.queryByText('Résultats provisoires')).toBeNull();
});

test('bandeau : une information par ligne, et la gerbe dans une bande à droite', async () => {
  mockFetch(SHARE);
  renderPage();
  const facts = await screen.findByRole('list', { name: 'Informations sur la série' });
  const items = within(facts).getAllByRole('listitem').map((li) => li.textContent);
  expect(items).toHaveLength(3);
  expect(items[0]).toBe('4 modèles testés sur 2 cas, 1 répétition');
  expect(items[1]).toMatch(/^notés par un juge IA/);
  expect(items[2]).toMatch(/^coût total de la série/);
  expect(screen.getByTestId('share-gerbe')).toHaveClass('absolute', 'left-[calc(50%_+_60px)]');
  expect(screen.getByText('Date du test : 15 octobre 2026')).toBeInTheDocument();
  expect(screen.queryByText(/Résultats de/)).toBeNull();
});

test('ordre : verdicts, podium sur toute la largeur, constellation sur toute la largeur (sans impression), puis le nuage', async () => {
  mockFetch(SHARE);
  renderPage();
  const heading = await screen.findByRole('heading', { name: /Constellation des modèles/ });
  expect(heading.closest('.no-print')).not.toBeNull();
  expect(screen.getByRole('list', { name: 'Légende de la constellation' })).toBeInTheDocument();
  const main = screen.getByRole('main');
  const verdicts = screen.getByRole('list', { name: 'Verdicts' });
  const podiumCard = screen.getByRole('heading', { level: 2, name: 'Podium' }).closest('.card-surface')!;
  const constellationCard = screen.getByTestId('constellation-fallback').closest('.no-print')!;
  const scatterCard = screen.getByTestId('quality-speed-chart').parentElement!;
  // Podium et constellation sont des enfants directs de la colonne : plus de grille côte à côte.
  expect(podiumCard.parentElement).toBe(main);
  expect(constellationCard.parentElement).toBe(main);
  expect(main.querySelector('[class*="grid-cols-[1.4fr_1fr]"]')).toBeNull();
  const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  expect(follows(verdicts, podiumCard)).toBe(true);
  expect(follows(podiumCard, constellationCard)).toBe(true);
  expect(follows(constellationCard, scatterCard)).toBe(true);
  // Le podium remplit une zone de hauteur fixe, masquée à l'impression (le podium statique la remplace).
  expect(screen.getByRole('list', { name: 'Podium' }).parentElement).toHaveClass('no-print', 'h-[280px]');
});

test('nuage : tous les modèles, aide avec les définitions, plus de mention « premiers modèles »', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ ...models[0]!, modelId: `x${i}`, name: `Modèle ${i}` }));
  mockFetch({ ...SHARE, models: many });
  renderPage();
  await screen.findByRole('heading', { level: 1, name: SHARE.title });
  expect(screen.queryByText(/premiers modèles sur/)).toBeNull();
  expect(within(screen.getByRole('list', { name: 'Légende du nuage' })).getAllByRole('listitem')).toHaveLength(8);
  const help = screen.getByRole('button', { name: 'Aide : Qualité et vitesse' });
  const text = document.getElementById(help.getAttribute('aria-describedby')!)?.textContent ?? '';
  expect(text).toContain(DEFINITIONS.quality);
  expect(text).toContain(DEFINITIONS.speed);
});

test('bandeau : répétitions au pluriel juste après le nombre de cas', async () => {
  mockFetch({ ...SHARE, run: { ...SHARE.run, repetitions: 3 } });
  renderPage();
  const facts = await screen.findByRole('list', { name: 'Informations sur la série' });
  expect(within(facts).getAllByRole('listitem')[0]).toHaveTextContent('4 modèles testés sur 2 cas, 3 répétitions');
});

test('pondération sous le podium : critères avec aide « ? », 0 % omis ; coût omis quand les coûts sont masqués', async () => {
  mockFetch({ ...SHARE, weights: { quality: 80, speed: 5, cost: 15, reliability: 0 } });
  const { unmount } = renderPage();
  const list = await screen.findByRole('list', { name: 'Pondération du score global' });
  expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Qualité?80 %', '|Vitesse?5 %', '|Coût?15 %']);
  expect(within(list).getByRole('button', { name: 'Aide : Vitesse' })).toHaveAccessibleDescription(DEFINITIONS.speed);
  expect(screen.getByRole('heading', { level: 2, name: 'Podium' }).closest('.card-surface')).toContainElement(list);
  expect(screen.getByRole('button', { name: 'Aide : Podium' })).toBeInTheDocument();
  unmount();
  mockFetch({ ...SHARE, showCosts: false, weights: { quality: 80, speed: 5, cost: 15, reliability: 0 } });
  renderPage();
  const hidden = await screen.findByRole('list', { name: 'Pondération du score global' });
  expect(within(hidden).queryByText('Coût')).toBeNull();
});

test('classement détaillé avant la matrice ; clic sur une note : réponses filtrées par modèle et catégorie', async () => {
  const user = userEvent.setup();
  const responses = [
    { testName: 'Lettre', category: 'Rédaction', userPrompt: 'Écris.', detail: { ...DETAIL, systemPrompt: 'Sois concis.' }, answers: [
      { modelKey: 'm1', repetition: 1, text: 'Lettre Alpha', finalScore: 90, judgeRationale: null },
      { modelKey: 'm2', repetition: 1, text: 'Lettre Bravo', finalScore: 70, judgeRationale: null },
    ] },
    { testName: 'Énigme', category: 'Logique', userPrompt: 'Résous.', detail: DETAIL, answers: [{ modelKey: 'm1', repetition: 1, text: 'Énigme Alpha', finalScore: 80, judgeRationale: null }] },
  ];
  mockFetch({ ...SHARE, responses });
  renderPage();
  const matrix = await screen.findByRole('table', { name: 'Qualité par catégorie de test' });
  const ranking = screen.getByRole('heading', { name: /Classement détaillé/ });
  expect(ranking.compareDocumentPosition(matrix) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.click(within(matrix).getByRole('button', { name: /^Bravo · Rédaction/ }));
  const section = within(screen.getByRole('region', { name: 'Réponses des modèles' }));
  expect(section.getByRole('status')).toHaveTextContent('Filtre : Bravo · Rédaction (1 test)');
  expect(section.getByText('Lettre Bravo')).toBeInTheDocument();
  expect(section.queryByText('Lettre Alpha')).toBeNull();
  expect(within(section.getByLabelText('Test')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Lettre']);
  await user.click(section.getByRole('button', { name: 'Retirer le filtre' }));
  expect(section.getByText('Lettre Alpha')).toBeInTheDocument();
});

test('réponses publiées : filtre Modèle et détail du test dans une fenêtre', async () => {
  const user = userEvent.setup();
  const responses = [
    { testName: 'Lettre', category: 'Rédaction', userPrompt: 'Écris.', detail: { ...DETAIL, systemPrompt: 'Sois concis.' }, answers: [
      { modelKey: 'm1', repetition: 1, text: 'Lettre Alpha', finalScore: 90, judgeRationale: null },
      { modelKey: 'm2', repetition: 1, text: 'Lettre Bravo', finalScore: 70, judgeRationale: null },
    ] },
  ];
  mockFetch({ ...SHARE, responses });
  renderPage();
  const section = within(await screen.findByRole('region', { name: 'Réponses des modèles' }));
  await user.selectOptions(section.getByRole('combobox', { name: 'Modèle' }), 'm2');
  expect(section.queryByText('Lettre Alpha')).toBeNull();
  expect(section.getByText('Lettre Bravo')).toBeInTheDocument();
  expect(section.getByRole('status')).toHaveTextContent('Filtre : Bravo · toutes les catégories (1 test)');
  await user.click(section.getByRole('button', { name: 'Lettre' }));
  const dialog = within(await screen.findByRole('dialog', { name: 'Lettre' }));
  expect(dialog.getByText('Sois concis.')).toBeInTheDocument();
  expect(dialog.getByText('Clarté et justesse.')).toBeInTheDocument();
});
