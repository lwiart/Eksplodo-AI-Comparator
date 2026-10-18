import { act, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { CONSTELLATION_HOVER_EVENT, UNRATED_COLOR, type ConstellationHover } from '../../three/constellation-scene';
import { Constellation, hoverDetails } from './Constellation';
import { MODELS } from './ranking.fixtures';

/** Simule l'événement émis par le canevas de la scène : il remonte jusqu'au cadre de la constellation. */
function hover(detail: ConstellationHover | null) {
  const origin = screen.getByTestId('constellation-fallback');
  act(() => {
    origin.dispatchEvent(new CustomEvent(CONSTELLATION_HOVER_EVENT, { bubbles: true, detail }));
  });
}

test('légende claire : « vitesse de rotation » au lieu de « orbite », plus de zoom', () => {
  render(<Constellation models={MODELS} />);
  expect(screen.getByText(/Taille = qualité · Vitesse de rotation = débit/)).toBeInTheDocument();
  expect(screen.getByText(/Survolez un astre pour son nom/)).toBeInTheDocument();
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
  expect(text).toMatch(/vitesse de rotation suit le débit médian/);
  expect(text).toMatch(/orbites suivent le classement, le premier au plus près du centre/);
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
