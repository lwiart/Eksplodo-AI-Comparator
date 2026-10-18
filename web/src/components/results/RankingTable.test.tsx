import { render, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { rankedRows } from '../../lib/ranking';
import { DEFINITION_LABELS, DEFINITIONS, type DefinitionKey } from './definitions';
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

test('en-têtes : icône d’aide avec sa définition, nom accessible de la colonne inchangé', () => {
  render(<RankingTable rows={rows} />);
  const helps: [string, string, string][] = [
    ['Score global', 'Score global', DEFINITIONS.global],
    ['Qualité', 'Qualité', DEFINITIONS.quality],
    ['Premier token médian', 'Premier token (vitesse)', DEFINITIONS.speed],
    ['Débit médian', 'Débit (vitesse)', DEFINITIONS.speed],
    ['Coût moyen', 'Coût', DEFINITIONS.cost],
    ['Fiabilité', 'Fiabilité', DEFINITIONS.reliability],
  ];
  for (const [column, label, text] of helps) {
    const header = screen.getByRole('columnheader', { name: column });
    const help = within(header).getByRole('button', { name: `Aide : ${label}` });
    expect(help).toHaveAccessibleDescription(text);
    // Bulle masquée à l'impression : remplacée par le bloc « Définitions ».
    expect(help.closest('.no-print')).not.toBeNull();
  }
  expect(within(screen.getByRole('columnheader', { name: 'Rang' })).queryByRole('button')).toBeNull();
});

test('bloc « Définitions » imprimable sous le tableau, avec chaque critère', () => {
  render(<RankingTable rows={rows} />);
  const block = screen.getByRole('region', { name: 'Définitions' });
  expect(block).toHaveClass('print-only');
  for (const key of Object.keys(DEFINITIONS) as DefinitionKey[]) {
    expect(within(block).getByText(`${DEFINITION_LABELS[key]} :`)).toBeInTheDocument();
    expect(within(block).getByText(DEFINITIONS[key])).toBeInTheDocument();
  }
  // Classes des règles d'impression (theme.css) : tableau compact, défilement et barre du score neutralisés.
  expect(screen.getByRole('table')).toHaveClass('ranking-table');
  expect(screen.getByRole('table').parentElement).toHaveClass('ranking-scroll');
  expect(document.querySelectorAll('.ranking-bar')).toHaveLength(rows.length);
});

test('hideCosts : ni aide ni définition du coût', () => {
  render(<RankingTable rows={rows} hideCosts />);
  expect(screen.queryByRole('button', { name: 'Aide : Coût' })).toBeNull();
  const block = screen.getByRole('region', { name: 'Définitions' });
  expect(within(block).queryByText(DEFINITIONS.cost)).toBeNull();
  expect(within(block).getByText(DEFINITIONS.quality)).toBeInTheDocument();
});
