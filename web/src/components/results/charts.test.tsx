import { render, screen } from '@testing-library/react';
import { cloneElement, type ReactElement } from 'react';
import { expect, test, vi } from 'vitest';
import { CategoryChart, categoryRows } from './CategoryChart';
import { MODELS, RANKING } from './ranking.fixtures';
import { QualitySpeedChart, scatterPoints } from './QualitySpeedChart';

// jsdom ne mesure rien : le conteneur adaptatif reçoit une taille fixe.
vi.mock('recharts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) => cloneElement(children, { width: 600, height: 280 }),
}));

test('nuage : un point par modèle ayant qualité et vitesse', () => {
  expect(scatterPoints(MODELS).map((p) => [p.name, p.speed, p.quality])).toEqual([
    ['Alpha', 2, 9],
    ['Bravo', 6, 7],
    ['Charlie', 10, 3],
  ]);
  render(<QualitySpeedChart models={MODELS} />);
  const chart = screen.getByTestId('quality-speed-chart');
  expect(chart.querySelectorAll('.recharts-scatter')).toHaveLength(3);
  expect(chart.querySelector('.recharts-reference-area')).not.toBeNull();
  // Légende : chaque point est identifiable par le nom du modèle.
  for (const name of ['Alpha', 'Bravo', 'Charlie']) expect(chart.textContent).toContain(name);
  expect(chart.textContent).not.toContain('Delta');
});

test('catégories : une barre par modèle noté et par catégorie, absente sans note', () => {
  expect(categoryRows(MODELS, RANKING.categories)).toEqual([
    { category: 'Rédaction', a: 8, b: 8, c: 3 },
    { category: 'Logique', a: 7, b: 7 },
  ]);
  render(<CategoryChart models={MODELS} categories={RANKING.categories} />);
  const chart = screen.getByTestId('category-chart');
  // Delta n'a aucune note de catégorie : pas de série ; Charlie n'a pas de barre en Logique.
  expect(chart.querySelectorAll('.recharts-bar')).toHaveLength(3);
  expect(chart.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(5);
  expect(chart.textContent).toContain('Rédaction');
  expect(chart.textContent).toContain('Logique');
});

test('graphes vides : message plutôt qu’un graphe', () => {
  render(<QualitySpeedChart models={[MODELS[3]!]} />);
  expect(screen.getByText(/Pas encore de modèle/)).toBeInTheDocument();
});
