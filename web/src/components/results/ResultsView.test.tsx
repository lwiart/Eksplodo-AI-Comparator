import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, type ReactElement } from 'react';
import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { DEFINITIONS } from './definitions';
import { MODELS, RANKING, model } from './ranking.fixtures';
import ResultsView from './ResultsView';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../api/client')>()), apiFetch }));
vi.mock('recharts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) => cloneElement(children, { width: 600, height: 280 }),
}));

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ run: {} });
});

function renderView(isAdmin: boolean, ranking = RANKING) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ResultsView runId="r1" ranking={ranking} isAdmin={isAdmin} />
    </QueryClientProvider>,
  );
}
const table = () => within(screen.getByRole('table', { name: 'Classement détaillé' }));
const order = () => table().getAllByRole('rowheader').map((h) => h.textContent!.replace(/(Anthropic|OpenAI|Mistral|Autre)$/, ''));

test('le classement se réordonne instantanément sans appel serveur', async () => {
  const user = userEvent.setup();
  renderView(true);
  expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  const speed = screen.getByRole('slider', { name: 'Vitesse' });
  speed.focus();
  await user.keyboard('{ArrowRight>60/}');
  expect(speed).toHaveAttribute('aria-valuenow', '80');
  expect(order()).toEqual(['Charlie', 'Bravo', 'Alpha', 'Delta']);
  expect(apiFetch).not.toHaveBeenCalled();
});

test('tableau : « — » pour les valeurs nulles, modèle non noté en fin sans rang', () => {
  renderView(false);
  const cells = (name: RegExp) => table().getByRole('rowheader', { name }).closest('tr')!.querySelectorAll('td');
  expect([...cells(/Delta/)].map((c) => c.textContent)).toEqual(['—', '—', '—', '—', '—', '—', '100 %']);
  expect([...cells(/Alpha/)].map((c) => c.textContent)).toEqual(['1', '71', '90', '500 ms', '60 tokens/s', '0,003 $', '100 %']);
});

test('Admin : enregistrer la pondération envoie PATCH weights', async () => {
  const user = userEvent.setup();
  renderView(true);
  const save = screen.getByRole('button', { name: 'Enregistrer comme pondération par défaut' });
  expect(save).toBeDisabled();
  screen.getByRole('slider', { name: 'Qualité' }).focus();
  await user.keyboard('{ArrowRight>10/}');
  expect(save).toBeEnabled();
  await user.click(save);
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith('/api/runs/r1', { method: 'PATCH', body: { weights: { quality: 60, speed: 16, cost: 16, reliability: 8 } } }),
  );
});

test('Utilisateur : bouton d’enregistrement absent, export présent', () => {
  renderView(false);
  expect(screen.queryByRole('button', { name: /Enregistrer comme pondération/ })).toBeNull();
  const exportLink = screen.getByRole('link', { name: 'Exporter' });
  // Classeur XLSX, téléchargé (attribut download conservé).
  expect(exportLink).toHaveAttribute('href', '/api/runs/r1/export.xlsx');
  expect(exportLink).toHaveAttribute('download');
});

test('graphes : titre « Qualité par catégorie de test » et libellé de l’axe des qualités', () => {
  renderView(false);
  expect(screen.getByRole('heading', { level: 2, name: 'Qualité par catégorie de test note moyenne sur 100' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /^Par catégorie/ })).toBeNull();
  expect(screen.getByTestId('quality-speed-chart').textContent).toContain('Qualité (note sur 100)');
});

test('mise en page : nuage puis matrice par catégorie, chacun sur toute la largeur', () => {
  renderView(false);
  const card = (name: string) => screen.getByRole('heading', { level: 2, name }).parentElement!;
  const scatter = card('Qualité et vitesse en haut à droite : idéal');
  const heatmap = card('Qualité par catégorie de test note moyenne sur 100');
  expect(within(scatter).getByTestId('quality-speed-chart')).toBeInTheDocument();
  expect(within(heatmap).getByRole('table', { name: 'Qualité par catégorie de test' })).toBeInTheDocument();
  // Plus de grille à deux colonnes : les deux cartes sont des enfants directs de la colonne des résultats, l'une sous l'autre.
  const section = screen.getByRole('region', { name: 'Résultats' });
  expect(scatter.parentElement).toBe(section);
  expect(heatmap.parentElement).toBe(section);
  expect(section).toHaveClass('flex', 'flex-col');
  expect(scatter.compareDocumentPosition(heatmap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(section.querySelector('.lg\\:grid-cols-2')).toBeNull();
});

test('matrice par catégorie : lignes dans l’ordre du classement, réordonnées avec la pondération', async () => {
  const user = userEvent.setup();
  renderView(false);
  const matrix = () => within(screen.getByRole('table', { name: 'Qualité par catégorie de test' }));
  const rows = () => matrix().getAllByRole('rowheader').map((h) => h.textContent!.replace(/(Anthropic|OpenAI|Mistral|Autre)$/, ''));
  expect(rows()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  const speed = screen.getByRole('slider', { name: 'Vitesse' });
  speed.focus();
  await user.keyboard('{ArrowRight>60/}');
  expect(rows()).toEqual(['Charlie', 'Bravo', 'Alpha']);
});

test('pondération : une icône d’aide par curseur, avec la définition du critère', () => {
  renderView(false);
  const group = within(screen.getByRole('group', { name: 'Pondération' }));
  const helps: [string, string][] = [
    ['Qualité', DEFINITIONS.quality],
    ['Vitesse', DEFINITIONS.speed],
    ['Coût', DEFINITIONS.cost],
    ['Fiabilité', DEFINITIONS.reliability],
  ];
  for (const [label, text] of helps) expect(group.getByRole('button', { name: `Aide : ${label}` })).toHaveAccessibleDescription(text);
  // Les curseurs gardent leur nom accessible.
  for (const [label] of helps) expect(group.getByRole('slider', { name: label })).toBeInTheDocument();
});

test('classement détaillé : aides sur les en-têtes et définitions imprimables', () => {
  renderView(false);
  expect(table().getByRole('button', { name: 'Aide : Qualité' })).toHaveAccessibleDescription(DEFINITIONS.quality);
  expect(table().getByRole('button', { name: 'Aide : Fiabilité' })).toHaveAccessibleDescription(DEFINITIONS.reliability);
  expect(screen.getByRole('region', { name: 'Définitions' })).toHaveClass('print-only');
});

test('plus de six modèles : le nuage l’indique, la matrice les montre tous', () => {
  const extra = ['e', 'f', 'g', 'h'].map((id) => model({ modelId: id, name: `Extra ${id}` }));
  renderView(false, { ...RANKING, models: [...MODELS, ...extra] });
  const scatter = screen.getByRole('heading', { level: 2, name: 'Qualité et vitesse en haut à droite : idéal' }).parentElement!;
  expect(within(scatter).getByText(/6 premiers modèles sur 8/)).toBeInTheDocument();
  // Tous les modèles notés par catégorie (Delta n'en a aucune) : 7 lignes, au-delà des 6 du nuage.
  expect(within(screen.getByRole('table', { name: 'Qualité par catégorie de test' })).getAllByRole('rowheader')).toHaveLength(7);
});

test('six modèles ou moins : pas de mention', () => {
  renderView(false);
  expect(screen.queryByText(/premiers modèles sur/)).toBeNull();
});

test('constellation : repli SVG sans WebGL, un astre et une entrée de légende par modèle', () => {
  renderView(false);
  expect(screen.getAllByTestId('constellation-astre')).toHaveLength(MODELS.length);
  const legend = within(screen.getByRole('list', { name: 'Légende de la constellation' }));
  expect(legend.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
});
