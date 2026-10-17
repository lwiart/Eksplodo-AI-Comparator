import { expect, test } from 'vitest';
import {
  ARC_RX,
  ARC_RZ,
  FLASH_ERROR,
  FLASH_OK,
  MAX_PARTICLES,
  PARTICLES_PER_CALL,
  flashColor,
  nodePositions,
  particleCount,
  starCount,
  unseenFinished,
} from './live-flow-scene';

test('fonctions pures de la scène : positions des nœuds en arc, nombre de particules (moitié sur mobile)', () => {
  // Un seul modèle : au fond, dans l'axe du prompt.
  const [only] = nodePositions(1);
  expect(only!.x).toBeCloseTo(0);
  expect(only!.y).toBe(0);
  expect(only!.z).toBeCloseTo(-ARC_RZ);

  // Plusieurs modèles : tous sur l'ellipse, de gauche à droite, symétriques, l'arc ouvert vers la caméra.
  const pts = nodePositions(5);
  expect(pts).toHaveLength(5);
  pts.forEach((p) => {
    expect((p.x / ARC_RX) ** 2 + (p.z / ARC_RZ) ** 2).toBeCloseTo(1);
    expect(p.y).toBe(0);
  });
  for (let i = 1; i < pts.length; i++) expect(pts[i]!.x).toBeGreaterThan(pts[i - 1]!.x);
  expect(pts[0]!.x).toBeCloseTo(-pts[4]!.x);
  expect(pts[0]!.z).toBeCloseTo(pts[4]!.z);
  expect(pts[2]!.x).toBeCloseTo(0);
  expect(pts[2]!.z).toBeCloseTo(-ARC_RZ);
  expect(pts[0]!.z).toBeGreaterThan(pts[2]!.z);
  expect(nodePositions(0)).toEqual([]);
  // Deux modèles dessinent déjà un arc : tous deux derrière le prompt.
  nodePositions(2).forEach((p) => expect(p.z).toBeLessThan(-1));

  // Particules : une traînée par appel en cours, moitié moins sur mobile, plafonnée.
  expect(particleCount(0, false)).toBe(0);
  expect(particleCount(3, false)).toBe(3 * PARTICLES_PER_CALL);
  expect(particleCount(3, true)).toBe((3 * PARTICLES_PER_CALL) / 2);
  expect(particleCount(10_000, false)).toBe(MAX_PARTICLES);
  expect(particleCount(10_000, true)).toBe(MAX_PARTICLES / 2);
  expect(starCount(true)).toBe(starCount(false) / 2);
});

test('éclairs : seuls les résultats pas encore vus, vert si réussi, rouge en erreur', () => {
  const seen = new Set(['r1']);
  const finished = [
    { resultId: 'r2', modelId: 'm1', ok: true },
    { resultId: 'r1', modelId: 'm1', ok: true },
    { resultId: 'r3', modelId: 'm2', ok: false },
  ];
  expect(unseenFinished(seen, finished).map((f) => f.resultId)).toEqual(['r2', 'r3']);
  expect(flashColor(true)).toBe(FLASH_OK);
  expect(flashColor(false)).toBe(FLASH_ERROR);
  expect(FLASH_OK).toBe('#4FD1A5');
  expect(FLASH_ERROR).toBe('#FF7A7A');
});
