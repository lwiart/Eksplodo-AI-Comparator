import { expect, test } from 'vitest';
import { csvCell, csvDocument, csvFileName } from '../src/modules/scoring/csv.js';

test('CSV : BOM, séparateur ;, formule =SOMME(...) préfixée par une apostrophe, retours à la ligne entre guillemets', () => {
  expect(csvCell('=SOMME(A1:A2)')).toBe("'=SOMME(A1:A2)");
  expect(['+1', '-1', '@x', '\tx'].map(csvCell)).toEqual(["'+1", "'-1", "'@x", "'\tx"]);
  // Préfixe puis guillemets : la cellule commence par un retour chariot et en contient un.
  expect(csvCell('\rx')).toBe('"\'\rx"');
  expect(csvCell('a;b')).toBe('"a;b"');
  expect(csvCell('il dit "oui"')).toBe('"il dit ""oui"""');
  expect(csvCell('ligne 1\nligne 2')).toBe('"ligne 1\nligne 2"');
  expect(csvCell('=A1;B1')).toBe('"\'=A1;B1"');
  expect(csvCell('texte simple')).toBe('texte simple');
  expect(csvCell('')).toBe('');
  expect(csvCell(null)).toBe('');
  // Nombres à la française (virgule décimale), jamais préfixés.
  expect(csvCell(7)).toBe('7');
  expect(csvCell(0.0015)).toBe('0,0015');
  expect(csvCell(8.75)).toBe('8,75');

  const doc = csvDocument([
    ['série', 'réponse'],
    ['Polyvalence', '=SOMME(A1:A2)'],
    ['Polyvalence', 'Bonjour\nmonde ; "salut"'],
  ]);
  expect(doc.startsWith('﻿')).toBe(true);
  expect(doc).toBe('﻿série;réponse\r\nPolyvalence;\'=SOMME(A1:A2)\r\nPolyvalence;"Bonjour\nmonde ; ""salut"""\r\n');
});

test('nom du fichier : « serie- » suivi du nom de la série en minuscules, sans accents ni ponctuation', () => {
  expect(csvFileName('Polyvalence d’octobre (v2)')).toBe('serie-polyvalence-d-octobre-v2.csv');
  expect(csvFileName('Écriture & Rédaction')).toBe('serie-ecriture-redaction.csv');
  expect(csvFileName('***')).toBe('serie.csv');
  expect(csvFileName('a'.repeat(300))).toBe(`serie-${'a'.repeat(80)}.csv`);
});
