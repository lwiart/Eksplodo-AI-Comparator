import { render, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { rankedRows } from '../../lib/ranking';
import { MODELS, RANKING } from '../results/ranking.fixtures';
import { StaticPodium } from './StaticPodium';

test('StaticPodium : trois premiers sans canvas, modèle non noté absent', () => {
  const { container } = render(<StaticPodium rows={rankedRows(MODELS, RANKING.weights)} />);
  const items = within(screen.getByRole('list', { name: 'Podium imprimable', hidden: true })).getAllByRole('listitem', { hidden: true });
  expect(items.map((li) => li.textContent)).toEqual([
    expect.stringContaining('Alpha'),
    expect.stringContaining('Bravo'),
    expect.stringContaining('Charlie'),
  ]);
  expect(container.textContent).not.toContain('Delta');
  expect(container.querySelector('canvas')).toBeNull();
  expect(container.firstElementChild).toHaveClass('print-only');
});

test('StaticPodium : rien à afficher sans modèle classé', () => {
  const { container } = render(<StaticPodium rows={[]} />);
  expect(container).toBeEmptyDOMElement();
});
