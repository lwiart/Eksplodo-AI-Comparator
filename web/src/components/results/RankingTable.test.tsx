import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { rankedRows } from '../../lib/ranking';
import { MODELS, RANKING } from './ranking.fixtures';
import { RankingTable } from './RankingTable';

const rows = rankedRows(MODELS, RANKING.weights);

test('par défaut, la colonne « Coût moyen » est affichée', () => {
  render(<RankingTable rows={rows} />);
  expect(screen.getByRole('columnheader', { name: 'Coût moyen' })).toBeInTheDocument();
  expect(screen.getAllByText('0,003 $').length).toBeGreaterThan(0);
});

test('hideCosts retire la colonne coût et ses montants', () => {
  render(<RankingTable rows={rows} hideCosts />);
  expect(screen.queryByRole('columnheader', { name: 'Coût moyen' })).not.toBeInTheDocument();
  expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  expect(screen.getAllByRole('columnheader')).toHaveLength(7);
});
