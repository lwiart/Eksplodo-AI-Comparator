import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { expect, test } from 'vitest';
import { ConstellationFallback } from './ConstellationFallback';
import {
  FIRST_ORBIT,
  MAX_ORBIT,
  MAX_RADIUS,
  MAX_SPEED,
  MIN_RADIUS,
  MIN_SPEED,
  UNRATED_COLOR,
  UNRATED_RADIUS,
  astreColor,
  astreRadius,
  flowCount,
  ndcToScreen,
  orbitPosition,
  placeLabel,
  sameHover,
  orbitRadius,
  orbitRanks,
  orbitSpeed,
  starCount,
} from './constellation-scene';
import { ThreeStage } from './ThreeStage';
import { constellationScene } from './constellation-scene';

test('tailles proportionnelles à la qualité, astre gris pour un modèle non noté', () => {
  expect(astreRadius(0)).toBeCloseTo(MIN_RADIUS);
  expect(astreRadius(100)).toBeCloseTo(MAX_RADIUS);
  expect(astreRadius(50)).toBeCloseTo((MIN_RADIUS + MAX_RADIUS) / 2);
  expect(astreRadius(80)).toBeGreaterThan(astreRadius(60));
  // Bornée : une note hors échelle ne dépasse pas.
  expect(astreRadius(420)).toBeCloseTo(MAX_RADIUS);
  expect(astreRadius(-30)).toBeCloseTo(MIN_RADIUS);
  // Non noté : le plus petit de tous, gris.
  expect(astreRadius(null)).toBe(UNRATED_RADIUS);
  expect(UNRATED_RADIUS).toBeLessThan(astreRadius(0));
  expect(astreColor('#F0631F', null)).toBe(UNRATED_COLOR);
  expect(astreColor('#F0631F', 0)).toBe('#F0631F');
});

test('vitesse d’orbite croissante avec le débit, bornée', () => {
  expect(orbitSpeed(null, 100)).toBe(MIN_SPEED);
  expect(orbitSpeed(0, 100)).toBe(MIN_SPEED);
  expect(orbitSpeed(50, 0)).toBe(MIN_SPEED);
  expect(orbitSpeed(100, 100)).toBeCloseTo(MAX_SPEED);
  expect(orbitSpeed(500, 100)).toBeCloseTo(MAX_SPEED);
  expect(orbitSpeed(80, 100)).toBeGreaterThan(orbitSpeed(40, 100));
  expect(orbitSpeed(40, 100)).toBeGreaterThan(MIN_SPEED);
});

test('orbites : régulières, plafonnées, positions sur le cercle ; particules et étoiles réduites sur mobile', () => {
  expect(orbitRadius(0, 1)).toBe(FIRST_ORBIT);
  expect(orbitRadius(3, 4)).toBeGreaterThan(orbitRadius(2, 4));
  expect(orbitRadius(39, 40)).toBeCloseTo(MAX_ORBIT);
  const p = orbitPosition(3, 0.4, 1.1, 5);
  expect(Math.hypot(p.x, p.z)).toBeCloseTo(3);
  expect(Math.abs(p.y)).toBeLessThanOrEqual(0.08);
  expect(flowCount(true)).toBe(flowCount(false) / 2);
  expect(starCount(true)).toBe(starCount(false) / 2);
});

test('orbites par débit : le plus rapide au plus près du centre, puis par débit décroissant, sans débit à l’extérieur', () => {
  // Ordre reçu (classement) : a, b, c, d, e. Débits : 40, inconnu, 120, 80, inconnu.
  const ranks = orbitRanks([{ tokensPerS: 40 }, { tokensPerS: null }, { tokensPerS: 120 }, { tokensPerS: 80 }, { tokensPerS: null }]);
  expect(ranks).toEqual([2, 3, 0, 1, 4]);
  // Égalité de débit, ou débit illisible : l'ordre reçu départage.
  expect(orbitRanks([{ tokensPerS: 50 }, { tokensPerS: 50 }, { tokensPerS: Number.NaN }, { tokensPerS: 10 }])).toEqual([0, 1, 3, 2]);
  expect(orbitRanks([])).toEqual([]);
  // Le plus rapide a donc l'orbite la plus petite.
  expect(orbitRadius(ranks[2]!, 5)).toBe(FIRST_ORBIT);
  expect(orbitRadius(ranks[4]!, 5)).toBeGreaterThan(orbitRadius(ranks[1]!, 5));
});

test('survol : coordonnées écran, événement réémis seulement si l’astre change ou bouge d’au moins un demi-pixel', () => {
  expect(ndcToScreen(-1, 1, 800, 400)).toEqual({ x: 0, y: 0 });
  expect(ndcToScreen(1, -1, 800, 400)).toEqual({ x: 800, y: 400 });
  expect(ndcToScreen(0, 0, 800, 400)).toEqual({ x: 400, y: 200 });

  const a = { id: 'a', x: 100, y: 50, r: 10 };
  expect(sameHover(null, null)).toBe(true);
  expect(sameHover(a, null)).toBe(false);
  expect(sameHover(null, a)).toBe(false);
  expect(sameHover(a, { ...a, x: 100.3 })).toBe(true);
  expect(sameHover(a, { ...a, x: 101 })).toBe(false);
  expect(sameHover(a, { ...a, r: 12 })).toBe(false);
  expect(sameHover(a, { ...a, id: 'b' })).toBe(false);
});

test('étiquette : au-dessus de l’astre et centrée, en dessous s’il manque de place, toujours dans le cadre', () => {
  const box = { w: 600, h: 360 };
  const label = { w: 120, h: 24 };
  // Au-dessus : top = y - r - écart - hauteur ; centrée sur x.
  expect(placeLabel({ x: 300, y: 200, r: 10 }, label, box)).toEqual({ left: 240, top: 158 });
  // Trop près du haut : en dessous.
  expect(placeLabel({ x: 300, y: 20, r: 10 }, label, box)).toEqual({ left: 240, top: 38 });
  // Bords gauche et droit : maintenue dans le cadre avec la marge.
  expect(placeLabel({ x: 10, y: 200, r: 10 }, label, box).left).toBe(8);
  expect(placeLabel({ x: 595, y: 200, r: 10 }, label, box).left).toBe(600 - 120 - 8);
  // Cadre trop petit en hauteur : jamais sous le bas du cadre.
  expect(placeLabel({ x: 300, y: 30, r: 40 }, label, { w: 600, h: 60 }).top).toBe(60 - 24 - 8);
});

test('sans WebGL : repli SVG avec un astre par modèle', async () => {
  const data = {
    models: [
      { id: 'a', color: '#F0631F', quality: 90, tokensPerS: 60 },
      { id: 'b', color: '#3FA2E0', quality: null, tokensPerS: null },
    ],
  };
  render(
    createElement(ThreeStage, {
      factory: constellationScene,
      fallback: createElement(ConstellationFallback, { data }),
      data,
    }),
  );
  expect(document.querySelector('canvas')).toBeNull();
  const astres = screen.getAllByTestId('constellation-astre');
  expect(astres).toHaveLength(2);
  const fills = astres.map((g) => g.querySelectorAll('circle')[1]!.getAttribute('fill'));
  expect(fills).toEqual(['#F0631F', UNRATED_COLOR]);
});

test('repli SVG : l’orbite suit le débit, pas l’ordre reçu', () => {
  const data = {
    models: [
      { id: 'lent', color: '#F0631F', quality: 90, tokensPerS: 20 },
      { id: 'rapide', color: '#3FA2E0', quality: 70, tokensPerS: 90 },
    ],
  };
  render(createElement(ConstellationFallback, { data }));
  const orbits = screen.getAllByTestId('constellation-astre').map((g) => Number(g.querySelector('circle')!.getAttribute('r')));
  expect(orbits[1]).toBe(FIRST_ORBIT);
  expect(orbits[0]).toBeGreaterThan(orbits[1]!);
});
