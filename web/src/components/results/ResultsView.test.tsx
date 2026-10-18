import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, type ReactElement } from 'react';
import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
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
  expect(screen.getByRole('link', { name: 'Exporter' })).toHaveAttribute('href', '/api/runs/r1/export.csv');
});

test('plus de six modèles : les graphes l’indiquent', () => {
  const extra = ['e', 'f', 'g'].map((id) => model({ modelId: id, name: `Extra ${id}` }));
  renderView(false, { ...RANKING, models: [...MODELS, ...extra] });
  expect(screen.getByText(/6 premiers modèles sur 7/)).toBeInTheDocument();
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
