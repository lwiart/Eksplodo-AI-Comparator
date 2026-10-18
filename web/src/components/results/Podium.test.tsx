import { render, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { rankedRows } from '../../lib/ranking';
import { MODELS } from './ranking.fixtures';
import { Podium } from './Podium';

const DEFAULTS = { quality: 50, speed: 20, cost: 20, reliability: 10 };

test('podium : trois premiers au rang et au score, modèle non noté absent', () => {
  render(<Podium rows={rankedRows(MODELS, DEFAULTS)} />);
  const items = within(screen.getByRole('list', { name: 'Podium' })).getAllByRole('listitem');
  // Alpha : (50 × 90 + 20 × 20 + 20 × 60 + 10 × 100) / 100 = 71 ; Bravo : 69 ; Charlie : 65. Affichage : 2e, 1er, 3e.
  expect(items.map((li) => li.textContent)).toEqual(['2BravoOpenAI69', '1AlphaAnthropic71', '3CharlieMistral65']);
  expect(screen.queryByText('Delta')).toBeNull();
});

test('podium : aucun modèle noté, message au lieu des marches', () => {
  render(<Podium rows={rankedRows([MODELS[3]!], DEFAULTS)} />);
  expect(screen.queryByRole('list', { name: 'Podium' })).toBeNull();
  expect(screen.getByText(/Aucun modèle noté/)).toBeInTheDocument();
});

test('podium : un nom très long peut passer à la ligne dans la marche (min-w-0, break-words)', () => {
  const long = { ...MODELS[0]!, name: 'openrouter/anthropic/claude-opus-4-very-long-identifier-preview' };
  render(<Podium rows={rankedRows([long], DEFAULTS)} />);
  const name = screen.getByText(long.name);
  expect(name).toHaveClass('min-w-0', 'break-words');
  expect(within(screen.getByRole('list', { name: 'Podium' })).getByRole('listitem')).toHaveClass('min-w-0');
});

test('podium : pleine hauteur de sa zone, 1re marche en haut, 2e et 3e moins hautes, marches centrées et bornées en largeur', () => {
  render(<Podium rows={rankedRows(MODELS, DEFAULTS)} />);
  const list = screen.getByRole('list', { name: 'Podium' });
  // Le podium prend la hauteur de son conteneur, alignées en bas ; centré, sans s'étirer sur une zone très large.
  expect(list).toHaveClass('h-full', 'items-end', 'justify-center', 'mx-auto');
  const [second, first, third] = within(list).getAllByRole('listitem');
  expect(first).toHaveClass('h-full');
  expect(second).toHaveClass('h-[84%]');
  expect(third).toHaveClass('h-[70%]');
  for (const step of [first, second, third]) expect(step).toHaveClass('flex-1', 'max-w-[210px]');
});
