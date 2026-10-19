import { expect, test } from 'vitest';
import { cellLabel } from './LiveMatrix';

const cell = (over: Partial<Parameters<typeof cellLabel>[0]>) => ({ modelId: 'm1', pending: 0, running: 0, done: 0, failed: 0, unsupported: 0, truncated: 0, ...over });

test('case de la matrice : les réponses tronquées sont comptées à part', () => {
  expect(cellLabel(cell({ done: 1, truncated: 2 }))).toBe('1 réussi, 2 tronqués');
  expect(cellLabel(cell({ truncated: 1 }))).toBe('1 tronqué');
  expect(cellLabel(cell({ unsupported: 3 }))).toBe('non supporté');
});

test('légende des exécutions : réussi vert, en cours bleu, en erreur rouge, tronquée marron', async () => {
  const { render, screen, within } = await import('@testing-library/react');
  const { LiveMatrix } = await import('./LiveMatrix');
  render(<LiveMatrix matrix={[]} models={[]} />);
  const legend = within(screen.getByRole('list', { name: 'Légende' }));
  const swatch = (label: string) => legend.getByText(label).querySelector('span') ?? legend.getByText(label).previousElementSibling;
  expect(legend.getByText('Réussi').querySelector('span')).toHaveClass('bg-good');
  expect(legend.getByText('En cours').querySelector('span')).toHaveClass('bg-blue');
  expect(legend.getByText('Erreur').querySelector('span')).toHaveClass('bg-run-error');
  expect(swatch('Tronquée (limite de tokens)')).toHaveClass('bg-truncated');
});
