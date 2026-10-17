// Export CSV pour un tableur français : séparateur `;`, UTF-8 avec BOM, lignes CRLF, virgule décimale.

export type CsvValue = string | number | null;

/** Début de cellule qu'un tableur interpréterait comme une formule (injection de formules). */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[;"\r\n]/;

/**
 * Cellule échappée : nombre à la virgule décimale ; texte préfixé par `'` s'il commence comme une formule, puis entre
 * guillemets (guillemets doublés) s'il contient `;`, un guillemet ou un retour à la ligne ; `null` : cellule vide.
 */
export function csvCell(v: CsvValue): string {
  if (v === null) return '';
  if (typeof v === 'number') return String(v).replace('.', ',');
  const text = FORMULA_START.test(v) ? `'${v}` : v;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Document complet : BOM, puis chaque ligne terminée par CRLF. */
export function csvDocument(rows: CsvValue[][]): string {
  return `﻿${rows.map((cells) => `${cells.map(csvCell).join(';')}\r\n`).join('')}`;
}

const MAX_SLUG = 80;

/** Nom du fichier : `serie-<nom>.csv`, nom en minuscules ASCII, mots séparés par des tirets (80 caractères au plus). */
export function csvFileName(runName: string): string {
  const slug = runName
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  return slug === '' ? 'serie.csv' : `serie-${slug}.csv`;
}
