import { render, screen } from '@testing-library/react';
import { cloneElement, type ReactElement } from 'react';
import { expect, test, vi } from 'vitest';
import { MODELS } from './ranking.fixtures';
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

test('graphes vides : message plutôt qu’un graphe', () => {
  render(<QualitySpeedChart models={[MODELS[3]!]} />);
  expect(screen.getByText(/Pas encore de modèle/)).toBeInTheDocument();
});
