import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { CONSTELLATION_HOVER_EVENT, CONSTELLATION_PIN_EVENT, UNRATED_COLOR, type ConstellationHover } from '../../three/constellation-scene';
import { Constellation, hoverDetails } from './Constellation';
import { MODELS } from './ranking.fixtures';

/** Simule l'événement émis par le canevas de la scène : il remonte jusqu'au cadre de la constellation. */
function hover(detail: ConstellationHover | null) {
  const origin = screen.getByTestId('constellation-fallback');
  act(() => {
    origin.dispatchEvent(new CustomEvent(CONSTELLATION_HOVER_EVENT, { bubbles: true, detail }));
  });
}

test('légende claire : « plus près du centre = débit plus élevé », plus de zoom', () => {
  render(<Constellation models={MODELS} />);
  expect(screen.getByText(/Taille = qualité · Plus près du centre = débit plus élevé/)).toBeInTheDocument();
  expect(screen.queryByText(/Vitesse de rotation = débit/)).toBeNull();
  expect(screen.getByText(/Touchez ou survolez un astre pour son nom/)).toBeInTheDocument();
  expect(screen.queryByText(/ZOOMER/i)).toBeNull();
  expect(screen.queryByText(/ORBITE = DÉBIT/i)).toBeNull();
});

test('icône d’aide à côté du titre, qui explique comment lire la scène', () => {
  render(<Constellation models={MODELS} />);
  expect(screen.getByRole('heading', { name: 'Constellation des modèles' })).toBeInTheDocument();
  const help = screen.getByRole('button', { name: 'Aide : Constellation' });
  const text = document.getElementById(help.getAttribute('aria-describedby')!)?.textContent ?? '';
  expect(text).toMatch(/taille suit la qualité \(note sur 100\)/);
  expect(text).toMatch(/gris et plus petit, il n’est pas encore noté/);
  expect(text).toMatch(/distance au centre suit le débit médian/);
  expect(text).toMatch(/le modèle le plus proche du centre a le plus haut débit/);
  expect(text).toMatch(/sans débit mesuré sont sur les orbites extérieures/);
  expect(text).not.toMatch(/orbites suivent le classement/);
});

test('survol : étiquette avec nom, qualité, débit et couleur du modèle ; « Pas encore noté » ; disparaît ensuite', () => {
  render(<Constellation models={MODELS} />);
  expect(screen.queryByTestId('constellation-etiquette')).toBeNull();

  hover({ id: 'a', x: 120, y: 140, r: 12 });
  const label = screen.getByTestId('constellation-etiquette');
  expect(label).toHaveTextContent('Alpha');
  expect(label).toHaveTextContent('Qualité 90/100 · 60 tokens/s');
  expect(label).toHaveStyle({ borderColor: '#F0631F' });

  hover({ id: 'd', x: 200, y: 80, r: 8 });
  expect(screen.getByTestId('constellation-etiquette')).toHaveTextContent('DeltaPas encore noté');
  expect(screen.getByTestId('constellation-etiquette')).toHaveStyle({ borderColor: UNRATED_COLOR });

  hover(null);
  expect(screen.queryByTestId('constellation-etiquette')).toBeNull();
});

test('mesures de l’étiquette : qualité arrondie, débit omis s’il est inconnu', () => {
  expect(hoverDetails(MODELS[0]!)).toBe('Qualité 90/100 · 60 tokens/s');
  expect(hoverDetails({ ...MODELS[1]!, quality: 72.6, raw: { ...MODELS[1]!.raw, medianTokensPerS: null } })).toBe('Qualité 73/100');
  expect(hoverDetails(MODELS[3]!)).toBe('Pas encore noté');
});

test('légende sous la scène (jamais par-dessus) ; toucher une pastille met sa planète en surbrillance, sans ligne de détail', async () => {
  const user = userEvent.setup();
  render(<Constellation models={MODELS} />);
  const legend = screen.getByRole('list', { name: 'Légende de la constellation' });
  // La légende est dans le flux, pas en position absolue au-dessus de la scène.
  expect(legend.closest('.absolute')).toBeNull();
  const first = MODELS[0]!;
  const chip = within(legend).getByRole('button', { name: first.name });
  await user.click(chip);
  expect(chip).toHaveAttribute('aria-pressed', 'true');
  // Repli SVG : l'astre choisi est marqué ; aucune ligne de détail sous la légende.
  expect(screen.getAllByTestId('constellation-astre').filter((g) => g.dataset.selected === 'true')).toHaveLength(1);
  expect(screen.queryByRole('status')).toBeNull();
  await user.click(chip);
  expect(chip).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getAllByTestId('constellation-astre').filter((g) => g.dataset.selected === 'true')).toHaveLength(0);
});

test('appui sur une planète (événement de la scène) : sa pastille est marquée', () => {
  render(<Constellation models={MODELS} />);
  const origin = screen.getByTestId('constellation-fallback');
  act(() => {
    origin.dispatchEvent(new CustomEvent(CONSTELLATION_PIN_EVENT, { bubbles: true, detail: MODELS[1]!.modelId }));
  });
  const legend = screen.getByRole('list', { name: 'Légende de la constellation' });
  expect(within(legend).getByRole('button', { name: MODELS[1]!.name })).toHaveAttribute('aria-pressed', 'true');
});
