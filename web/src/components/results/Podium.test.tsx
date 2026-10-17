import { render, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { rankedRows } from '../../lib/ranking';
import { MODELS } from './fixtures';
import { Podium } from './Podium';

const DEFAULTS = { quality: 50, speed: 20, cost: 20, reliability: 10 };

test('podium : trois premiers au rang et au score, modèle non noté absent', () => {
  render(<Podium rows={rankedRows(MODELS, DEFAULTS)} />);
  const items = within(screen.getByRole('list', { name: 'Podium' })).getAllByRole('listitem');
  // Alpha : (50 × 9 + 20 × 2 + 20 × 6 + 10 × 10) / 100 = 7,1 ; Bravo : 6,9 ; Charlie : 6,5. Affichage : 2e, 1er, 3e.
  expect(items.map((li) => li.textContent)).toEqual(['2BravoOpenAI6,9', '1AlphaAnthropic7,1', '3CharlieMistral6,5']);
  expect(screen.queryByText('Delta')).toBeNull();
});

test('podium : aucun modèle noté, message au lieu des marches', () => {
  render(<Podium rows={rankedRows([MODELS[3]!], DEFAULTS)} />);
  expect(screen.queryByRole('list', { name: 'Podium' })).toBeNull();
  expect(screen.getByText(/Aucun modèle noté/)).toBeInTheDocument();
});
