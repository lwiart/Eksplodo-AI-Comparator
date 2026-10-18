import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, type ReactElement } from 'react';
import { expect, test, vi } from 'vitest';
import { MODELS } from './ranking.fixtures';
import { DEFINITIONS } from './definitions';
import { QualitySpeedChart, QualitySpeedHeading, scatterPoints } from './QualitySpeedChart';

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

test('nuage : légende sous le graphe, zone idéale sans libellé qui masquerait des points', () => {
  render(<QualitySpeedChart models={MODELS} />);
  const chart = screen.getByTestId('quality-speed-chart');
  const plot = screen.getByRole('img', { name: 'Nuage qualité et vitesse des modèles' });
  const legend = screen.getByRole('list', { name: 'Légende du nuage' });
  expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  // Légende après le graphe, hors du SVG de recharts.
  expect(plot.compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(plot).not.toContainElement(legend);
  expect(chart.querySelector('.recharts-legend-wrapper')).toBeNull();
  expect(chart.textContent).not.toContain('Zone idéale');
});

test('nuage : tous les modèles, sans limite aux six premiers', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ ...MODELS[0]!, modelId: `m${i}`, name: `Modèle ${i}` }));
  render(<QualitySpeedChart models={many} />);
  expect(screen.getByTestId('quality-speed-chart').querySelectorAll('.recharts-scatter')).toHaveLength(9);
  expect(within(screen.getByRole('list', { name: 'Légende du nuage' })).getAllByRole('listitem')).toHaveLength(9);
});

test('titre du bloc : zone idéale expliquée dans le sous-titre, définitions de la qualité et de la vitesse dans l’aide', () => {
  render(<QualitySpeedHeading />);
  expect(screen.getByRole('heading', { level: 2, name: 'Qualité et vitesse zone orangée en haut à droite : idéal' })).toBeInTheDocument();
  const help = screen.getByRole('button', { name: 'Aide : Qualité et vitesse' });
  const text = document.getElementById(help.getAttribute('aria-describedby')!)?.textContent ?? '';
  expect(text).toContain(DEFINITIONS.quality);
  expect(text).toContain(DEFINITIONS.speed);
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

test('nuage : toucher un point le fait pulser et affiche sa bulle ; un second toucher la referme', async () => {
  const user = userEvent.setup();
  render(<QualitySpeedChart models={MODELS} />);
  const points = screen.getAllByTestId('quality-speed-point');
  expect(points).toHaveLength(3);
  const bravo = points.find((p) => p.getAttribute('aria-label') === 'Bravo')!;
  await user.click(bravo);
  // Le point est redessiné : on le relit après le toucher.
  const pinned = screen.getAllByTestId('quality-speed-point').find((p) => p.getAttribute('aria-label') === 'Bravo')!;
  expect(pinned).toHaveAttribute('data-pinned', 'true');
  expect(pinned.querySelector('animate[attributeName="r"]')).not.toBeNull();
  const popup = screen.getByTestId('quality-speed-popup');
  expect(popup).toHaveTextContent('Bravo');
  expect(popup).toHaveTextContent('Qualité 70');
  expect(popup).toHaveTextContent('Vitesse 60');
  const again = screen.getAllByTestId('quality-speed-point').find((p) => p.getAttribute('aria-label') === 'Bravo')!;
  await user.click(again);
  // Libéré : plus de pulsation ; la bulle de survol reste tant que la souris est dessus, puis disparaît.
  const released = screen.getAllByTestId('quality-speed-point').find((p) => p.getAttribute('aria-label') === 'Bravo')!;
  expect(released).not.toHaveAttribute('data-pinned');
  expect(released.querySelector('animate')).toBeNull();
  // Le point a été redessiné au clic : la sortie de la souris lui est envoyée directement.
  fireEvent.mouseLeave(released);
  expect(screen.queryByTestId('quality-speed-popup')).toBeNull();
});

test('nuage : pas de contour de focus du navigateur sur le graphe (plus de rectangle blanc au toucher)', () => {
  render(<QualitySpeedChart models={MODELS} />);
  const frame = screen.getByRole('img', { name: 'Nuage qualité et vitesse des modèles' });
  expect(frame.className).toContain('[&_*:focus]:outline-none');
  expect(frame.querySelector('.recharts-wrapper [tabindex="0"]')).toBeNull();
});

test('nuage : un clic sur un nom de la légende choisit son point (pulsation et bulle), un second le libère', async () => {
  const user = userEvent.setup();
  render(<QualitySpeedChart models={MODELS} />);
  const legend = within(screen.getByRole('list', { name: 'Légende du nuage' }));
  await user.click(legend.getByRole('button', { name: 'Charlie' }));
  expect(legend.getByRole('button', { name: 'Charlie' })).toHaveAttribute('aria-pressed', 'true');
  const charlie = screen.getAllByTestId('quality-speed-point').find((p) => p.getAttribute('aria-label') === 'Charlie')!;
  expect(charlie).toHaveAttribute('data-pinned', 'true');
  expect(screen.getByTestId('quality-speed-popup')).toHaveTextContent('Charlie');
  await user.click(legend.getByRole('button', { name: 'Charlie' }));
  expect(screen.queryByTestId('quality-speed-popup')).toBeNull();
});
