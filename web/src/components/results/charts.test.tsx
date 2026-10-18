import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { cloneElement, type ReactElement } from 'react';
import { expect, test, vi } from 'vitest';
import { CategoryChart, categoryRows, categorySeries } from './CategoryChart';
import { MODELS, RANKING, model } from './ranking.fixtures';
import { QualitySpeedChart, scatterPoints } from './QualitySpeedChart';

// jsdom ne mesure rien : le conteneur adaptatif reçoit une taille fixe.
vi.mock('recharts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) => cloneElement(children, { width: 600, height: 280 }),
}));

test('nuage : un point par modèle ayant qualité et vitesse', () => {
  expect(scatterPoints(MODELS).map((p) => [p.name, p.speed, p.quality])).toEqual([
    ['Alpha', 20, 90],
    ['Bravo', 60, 70],
    ['Charlie', 100, 30],
  ]);
  render(<QualitySpeedChart models={MODELS} />);
  const chart = screen.getByTestId('quality-speed-chart');
  expect(chart.querySelectorAll('.recharts-scatter')).toHaveLength(3);
  expect(chart.querySelector('.recharts-reference-area')).not.toBeNull();
  // Légende : chaque point est identifiable par le nom du modèle.
  for (const name of ['Alpha', 'Bravo', 'Charlie']) expect(chart.textContent).toContain(name);
  expect(chart.textContent).not.toContain('Delta');
});

test('nuage : titres des deux axes, dont « Qualité (note sur 100) » vertical sur l’axe Y', () => {
  render(<QualitySpeedChart models={MODELS} />);
  const chart = screen.getByTestId('quality-speed-chart');
  const labels = [...chart.querySelectorAll('text.recharts-label')];
  expect(labels.map((t) => t.textContent)).toEqual(expect.arrayContaining(['Vitesse (note sur 100)', 'Qualité (note sur 100)']));
  const quality = labels.find((t) => t.textContent === 'Qualité (note sur 100)')!;
  expect(quality.getAttribute('transform')).toMatch(/^rotate\(-90/);
  // À gauche des graduations de l'axe Y (alignées à droite), sans les chevaucher.
  const tickX = Number(chart.querySelector('.recharts-yAxis-tick-labels text')!.getAttribute('x'));
  expect(Number(quality.getAttribute('x'))).toBeLessThan(tickX - 30);
});

test('catégories : une barre par modèle noté et par catégorie, absente sans note', () => {
  expect(categoryRows(MODELS, RANKING.categories)).toEqual([
    { category: 'Rédaction', a: 80, b: 80, c: 30 },
    { category: 'Logique', a: 70, b: 70 },
  ]);
  render(<CategoryChart models={MODELS} categories={RANKING.categories} />);
  const chart = screen.getByTestId('category-chart');
  // Delta n'a aucune note de catégorie : pas de série ; Charlie n'a pas de barre en Logique.
  expect(chart.querySelectorAll('.recharts-bar')).toHaveLength(3);
  expect(chart.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(5);
  expect(chart.textContent).toContain('Rédaction');
  expect(chart.textContent).toContain('Logique');
});

test('catégories : séries classées de la meilleure à la moins bonne qualité, sans qualité en fin, égalités dans l’ordre reçu', () => {
  const tie = model({ modelId: 't', name: 'Tango', quality: 70 });
  const noQuality = model({ modelId: 'n', name: 'Nova', quality: null });
  const series = categorySeries([MODELS[2]!, noQuality, MODELS[1]!, MODELS[3]!, tie, MODELS[0]!], RANKING.categories);
  // Delta n'a aucune note de catégorie : écarté.
  expect(series.map((m) => m.name)).toEqual(['Alpha', 'Bravo', 'Tango', 'Charlie', 'Nova']);
});

test('catégories : barres et légende du meilleur au moins bon, quel que soit l’ordre reçu', () => {
  render(<CategoryChart models={[...MODELS].reverse()} categories={RANKING.categories} />);
  const chart = screen.getByTestId('category-chart');
  // Légende sous le graphe, dans l'ordre des barres, chaque pastille à la couleur du modèle.
  const legend = screen.getByRole('list', { name: 'Légende : modèles du mieux au moins bien noté' });
  expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  expect(within(legend).getAllByRole('listitem').map((li) => (li.firstElementChild as HTMLElement).style.backgroundColor)).toEqual([
    'rgb(240, 99, 31)',
    'rgb(63, 162, 224)',
    'rgb(124, 196, 239)',
  ]);
  expect(chart.querySelector('.recharts-legend-wrapper')).toBeNull();
  // Premier groupe (Rédaction) : une barre par modèle, de gauche à droite dans le même ordre.
  const firstBars = [...chart.querySelectorAll('.recharts-bar')].map((bar) => bar.querySelector('path')!.getAttribute('fill'));
  expect(firstBars).toEqual(['#F0631F', '#3FA2E0', '#7CC4EF']);
});

test('catégories : l’infobulle ne détaille que la barre survolée', async () => {
  render(<CategoryChart models={MODELS} categories={RANKING.categories} />);
  const chart = screen.getByTestId('category-chart');
  // Barre de Bravo dans la catégorie Rédaction.
  const bravo = chart.querySelectorAll('.recharts-bar')[1]!.querySelector('.recharts-bar-rectangle')!;
  fireEvent.mouseEnter(bravo);
  fireEvent.mouseOver(bravo);
  const tooltip = await waitFor(() => {
    const t = chart.querySelector('.recharts-tooltip-wrapper');
    expect(t?.textContent).toContain('Bravo');
    return t!;
  });
  expect(tooltip.textContent).not.toContain('Alpha');
  expect(tooltip.textContent).not.toContain('Charlie');
});

test('graphes vides : message plutôt qu’un graphe', () => {
  render(<QualitySpeedChart models={[MODELS[3]!]} />);
  expect(screen.getByText(/Pas encore de modèle/)).toBeInTheDocument();
});
