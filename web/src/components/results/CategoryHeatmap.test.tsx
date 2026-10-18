import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { CategoryHeatmap, scoreColor } from './CategoryHeatmap';
import { DASH } from './format';
import { MODELS, RANKING, model } from './ranking.fixtures';

const matrix = () => within(screen.getByRole('table', { name: 'Qualité par catégorie de test' }));
const rowOrder = () => matrix().getAllByRole('rowheader').map((h) => h.textContent!.replace(/(Anthropic|OpenAI|Mistral|Autre|Fournisseur)$/, ''));

/** Echo, classé dernier, a la meilleure note en Logique : le tri par Logique le fait remonter. */
const ECHO = model({ modelId: 'e', name: 'Echo', quality: 50, byCategory: { Rédaction: 60, Logique: 95 } });

test('matrice : une ligne par modèle noté dans l’ordre reçu, avec pastille et fournisseur ; une colonne par catégorie puis Qualité', () => {
  render(<CategoryHeatmap models={MODELS} categories={RANKING.categories} />);
  // Delta n'a aucune note de catégorie : pas de ligne.
  expect(rowOrder()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  const alpha = matrix().getByRole('rowheader', { name: /Alpha/ });
  expect(alpha).toHaveTextContent('Anthropic');
  expect((alpha.querySelector('[aria-hidden="true"]') as HTMLElement).style.backgroundColor).toBe('rgb(240, 99, 31)');
  expect(matrix().getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Modèle', 'Rédaction', 'Logique', 'Qualité']);
  // Légende de l'échelle sous la matrice.
  expect(within(screen.getByRole('group', { name: 'Légende : échelle des notes' })).getByText('50')).toBeInTheDocument();
});

test('matrice : chaque case porte la note entière, une infobulle et un nom accessible ; case sans note : tiret sur fond neutre', () => {
  render(<CategoryHeatmap models={[model({ modelId: 'x', name: 'Xray', quality: 86.6, byCategory: { Rédaction: 79.4, Logique: null } })]} categories={RANKING.categories} />);
  const redaction = matrix().getByRole('cell', { name: 'Xray · Rédaction : 79 sur 100' });
  expect(redaction).toHaveTextContent('79');
  expect(redaction).toHaveAttribute('title', 'Xray · Rédaction : 79 sur 100');
  expect(matrix().getByRole('cell', { name: 'Xray · Qualité : 87 sur 100' })).toHaveTextContent('87');
  const empty = matrix().getByRole('cell', { name: 'Xray · Logique : pas de note' });
  expect(empty).toHaveTextContent(DASH);
  expect(empty.style.backgroundColor).toBe('');
  expect(empty).toHaveClass('heatmap-empty');
});

test('matrice : fond selon la note, rouge-orangé en bas, ambre au milieu, vert d’eau en haut', () => {
  expect(scoreColor(0)).toBe('rgb(140, 45, 25)');
  expect(scoreColor(50)).toBe('rgb(150, 105, 20)');
  expect(scoreColor(100)).toBe('rgb(18, 120, 100)');
  expect(scoreColor(120)).toBe(scoreColor(100));
  render(<CategoryHeatmap models={MODELS} categories={RANKING.categories} />);
  const low = matrix().getByRole('cell', { name: 'Charlie · Rédaction : 30 sur 100' });
  const high = matrix().getByRole('cell', { name: 'Alpha · Qualité : 90 sur 100' });
  expect(low.style.backgroundColor).toBe(scoreColor(30));
  expect(high.style.backgroundColor).toBe(scoreColor(90));
  expect(low.style.backgroundColor).not.toBe(high.style.backgroundColor);
  // Texte blanc en ligne : lisible sur toutes les teintes, et non assombri par les règles d'impression.
  expect(high.style.color).toBe('rgb(255, 255, 255)');
});

test('matrice : un clic sur un en-tête trie par note décroissante (sans note en dernier), un second revient à l’ordre du classement', async () => {
  const user = userEvent.setup();
  render(<CategoryHeatmap models={[...MODELS, ECHO]} categories={RANKING.categories} />);
  const header = (name: string) => matrix().getByRole('columnheader', { name });
  expect(rowOrder()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Echo']);
  expect(header('Logique')).not.toHaveAttribute('aria-sort');

  await user.click(matrix().getByRole('button', { name: 'Logique' }));
  // Égalité Alpha/Bravo : ordre reçu conservé ; Charlie sans note en Logique : en dernier.
  expect(rowOrder()).toEqual(['Echo', 'Alpha', 'Bravo', 'Charlie']);
  expect(header('Logique')).toHaveAttribute('aria-sort', 'descending');
  expect(header('Qualité')).not.toHaveAttribute('aria-sort');

  // Autre colonne : le tri passe directement sur la qualité globale.
  await user.click(matrix().getByRole('button', { name: 'Qualité' }));
  expect(rowOrder()).toEqual(['Alpha', 'Bravo', 'Echo', 'Charlie']);
  expect(header('Qualité')).toHaveAttribute('aria-sort', 'descending');
  expect(header('Logique')).not.toHaveAttribute('aria-sort');

  await user.click(matrix().getByRole('button', { name: 'Qualité' }));
  expect(rowOrder()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Echo']);
  expect(matrix().queryAllByRole('columnheader').filter((h) => h.hasAttribute('aria-sort'))).toHaveLength(0);
});

test('matrice : défilement horizontal dans son conteneur, colonne des modèles fixe', () => {
  render(<CategoryHeatmap models={MODELS} categories={RANKING.categories} />);
  const table = screen.getByRole('table', { name: 'Qualité par catégorie de test' });
  expect(table.parentElement).toHaveClass('overflow-x-auto');
  for (const h of matrix().getAllByRole('rowheader')) expect(h).toHaveClass('sticky', 'left-0');
});

test('matrice vide : message plutôt qu’un tableau', () => {
  render(<CategoryHeatmap models={[MODELS[3]!]} categories={RANKING.categories} />);
  expect(screen.getByText('Pas encore de note par catégorie.')).toBeInTheDocument();
  expect(screen.queryByRole('table')).toBeNull();
});
