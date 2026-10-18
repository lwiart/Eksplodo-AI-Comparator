// Export XLSX d'une série : classeur à trois feuilles (Classement, Résultats, Définitions), en-têtes aux couleurs d'Eksplodo.
import ExcelJS from 'exceljs';
import type { Weights } from '../runs/runs.service.js';
import { rankModels } from './aggregate.js';
import { csvFileName, type CsvValue } from './csv.js';
import { DEFINITION_LABELS, DEFINITIONS, type DefinitionKey } from './definitions.js';
import type { RankingModel } from './results.service.js';

/** Orange Eksplodo (#F0631F) en ARGB, fond des lignes d'en-tête. */
export const HEADER_FILL = 'FFF0631F';
export const HEADER_FONT = 'FFFFFFFF';

export const SHEET_RANKING = 'Classement';
export const SHEET_RESULTS = 'Résultats';
export const SHEET_DEFINITIONS = 'Définitions';

/** Formats de nombre (codes Excel : le tableur affiche la virgule décimale selon sa langue). */
const FMT_SCORE = '0';
const FMT_INTEGER = '#,##0';
const FMT_RATE = '#,##0.0';
const FMT_USD = '0.000000 "$"';

/** Une colonne : titre, format de nombre éventuel et bornes de largeur (en caractères). */
type Column = { header: string; numFmt?: string; maxWidth?: number };

const RANKING_COLUMNS: Column[] = [
  { header: 'Rang', numFmt: FMT_SCORE },
  { header: 'Modèle' },
  { header: 'Fournisseur' },
  { header: 'Score global', numFmt: FMT_SCORE },
  { header: 'Qualité', numFmt: FMT_SCORE },
  { header: 'Vitesse', numFmt: FMT_SCORE },
  { header: 'Coût', numFmt: FMT_SCORE },
  { header: 'Fiabilité', numFmt: FMT_SCORE },
  { header: 'Premier token médian (ms)', numFmt: FMT_INTEGER },
  { header: 'Débit médian (tokens/s)', numFmt: FMT_RATE },
  { header: 'Coût moyen par réponse ($)', numFmt: FMT_USD },
];

/**
 * Formats des colonnes de la feuille Résultats, par titre de colonne du CSV. Les notes gardent leur valeur exacte (une
 * moyenne manuelle peut avoir des décimales) : format standard, sans arrondi d'affichage qui masquerait la valeur du CSV.
 */
const RESULT_FORMATS: Record<string, string> = {
  répétition: FMT_INTEGER,
  'premier token (ms)': FMT_INTEGER,
  'durée (ms)': FMT_INTEGER,
  'tokens/s': FMT_RATE,
  'tokens entrée': FMT_INTEGER,
  'tokens sortie': FMT_INTEGER,
  raisonnement: FMT_INTEGER,
  'coût ($)': FMT_USD,
  'coût du juge ($)': FMT_USD,
};

/** Largeur maximale des colonnes de texte libre (erreur, réponse) : au-delà, le texte déborde sans étirer la feuille. */
const WIDE_TEXT = 60;
const DEFAULT_MAX_WIDTH = 40;
const MIN_WIDTH = 8;

const DEFINITION_ORDER: DefinitionKey[] = ['global', 'quality', 'speed', 'cost', 'reliability'];

const round = (n: number | null): number | null => (n === null ? null : Math.round(n));
const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

/** Longueur affichée approximative d'une cellule (plus longue ligne d'un texte multiligne ; nombres formatés). */
function displayLength(v: CsvValue): number {
  if (v === null) return 0;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v).length + 1 : 12;
  return Math.max(...v.split(/\r?\n/).map((line) => line.length));
}

/**
 * Feuille avec en-tête en gras blanc sur fond orange, volet figé sous l'en-tête, formats de nombre par colonne et largeurs
 * adaptées au contenu. Valeurs écrites telles quelles : un texte reste un texte (jamais de formule, même s'il commence par `=`).
 */
function addTable(wb: ExcelJS.Workbook, name: string, columns: Column[], rows: CsvValue[][]): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  const header = ws.addRow(columns.map((c) => c.header));
  header.font = { bold: true, color: { argb: HEADER_FONT } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: 'middle' };
  for (const cells of rows) ws.addRow(cells.map((v) => (v === null ? undefined : v)));
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.numFmt) col.numFmt = c.numFmt;
    const longest = Math.max(c.header.length, ...rows.map((r) => displayLength(r[i] ?? null)));
    col.width = Math.min(c.maxWidth ?? DEFAULT_MAX_WIDTH, Math.max(MIN_WIDTH, longest + 2));
  });
  // Le format de colonne s'applique aussi à l'en-tête : il reste du texte, sans incidence.
  return ws;
}

export type WorkbookInput = {
  runName: string;
  weights: Weights;
  /** Modèles dans l'ordre du classement, tels que renvoyés par `ResultsService.ranking` (déjà masqués pour le compte). */
  models: RankingModel[];
  /** En-tête et lignes de l'export CSV (mêmes règles de masquage). */
  resultHeader: string[];
  resultLines: CsvValue[][];
};

/** Classeur de la série : classement (valeurs de la page, pondération de la série), résultats du CSV, définitions. */
export async function buildRunWorkbook(input: WorkbookInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Eksplodo';
  wb.title = input.runName;

  // Classement : rang et score global selon la pondération de la série, comme la page à son ouverture.
  const byId = new Map(input.models.map((m) => [m.modelId, m]));
  const rankingRows: CsvValue[][] = rankModels(input.models, input.weights).map(({ modelId, rank, global }) => {
    const m = byId.get(modelId)!;
    return [
      rank,
      m.name,
      m.providerName,
      round(global),
      round(m.quality),
      round(m.speed),
      round(m.cost),
      round(m.reliability),
      round(m.raw.medianTtftMs),
      round1(m.raw.medianTokensPerS),
      m.raw.meanCostUsd,
    ];
  });
  const ranking = addTable(wb, SHEET_RANKING, RANKING_COLUMNS, rankingRows);
  // Notes de bas de tableau (après une ligne vide) : pondération appliquée et renvoi vers les définitions.
  const w = input.weights;
  ranking.addRow([]);
  const notes = [
    `Pondération de la série : qualité ${w.quality} %, vitesse ${w.speed} %, coût ${w.cost} %, fiabilité ${w.reliability} %. Notes sur 100 arrondies à l'entier.`,
    `Définitions des critères : voir la feuille « ${SHEET_DEFINITIONS} ».`,
  ];
  for (const note of notes) ranking.addRow([note]).font = { italic: true };

  addTable(
    wb,
    SHEET_RESULTS,
    input.resultHeader.map((header) => ({
      header,
      numFmt: RESULT_FORMATS[header],
      maxWidth: header === 'réponse' || header === 'erreur' ? WIDE_TEXT : DEFAULT_MAX_WIDTH,
    })),
    input.resultLines,
  );

  const definitions = addTable(
    wb,
    SHEET_DEFINITIONS,
    [{ header: 'Critère' }, { header: 'Définition', maxWidth: 100 }],
    DEFINITION_ORDER.map((k) => [DEFINITION_LABELS[k], DEFINITIONS[k]]),
  );
  definitions.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  definitions.getColumn(1).alignment = { vertical: 'top' };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Nom du fichier : celui de l'export CSV, en `.xlsx`. */
export const xlsxFileName = (runName: string): string => csvFileName(runName).replace(/\.csv$/, '.xlsx');
