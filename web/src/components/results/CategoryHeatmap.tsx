import { useId, useMemo, useState } from 'react';
import type { RankingModel } from '../../api/results';
import { DASH, score } from './format';

/** Étapes de l'échelle de couleur (note sur 100 → fond de case), lisibles sous un texte blanc sur fond sombre comme sur papier. */
const STOPS: [number, [number, number, number]][] = [
  [0, [140, 45, 25]], // rouge-orangé sombre
  [50, [150, 105, 20]], // ambre
  [100, [18, 120, 100]], // vert d'eau
];

/** Fond d'une case notée : interpolation linéaire entre les étapes (note bornée à 0-100). */
export function scoreColor(n: number): string {
  const v = Math.min(100, Math.max(0, n));
  const i = v <= STOPS[1]![0] ? 0 : 1;
  const [x0, c0] = STOPS[i]!;
  const [x1, c1] = STOPS[i + 1]!;
  const t = (v - x0) / (x1 - x0);
  const [r, g, b] = c0.map((c, k) => Math.round(c + (c1[k]! - c) * t));
  return `rgb(${r}, ${g}, ${b})`;
}

/** Dégradé de la légende : mêmes étapes, même interpolation linéaire. */
const LEGEND_GRADIENT = `linear-gradient(to right, ${STOPS.map(([x, [r, g, b]]) => `rgb(${r}, ${g}, ${b}) ${x}%`).join(', ')})`;

/** Modèles ayant au moins une note de catégorie, dans l'ordre reçu (ordre du classement). */
export function heatmapModels(models: RankingModel[], categories: string[]): RankingModel[] {
  return models.filter((m) => categories.some((c) => m.byCategory[c] != null));
}

type Column = { key: string; label: string; category: string | null; value: (m: RankingModel) => number | null };

/** Modèles triés par note décroissante dans la colonne (sans note : en fin) ; à égalité, l'ordre reçu est conservé. */
export function sortByColumn(models: RankingModel[], value: (m: RankingModel) => number | null): RankingModel[] {
  const v = (m: RankingModel) => value(m) ?? Number.NEGATIVE_INFINITY;
  return [...models].sort((a, b) => v(b) - v(a));
}

const QUALITY_KEY = 'quality';

/** Case choisie : un modèle et une catégorie (`null` : la colonne Qualité, toutes catégories). */
export type HeatmapSelection = { modelId: string; category: string | null };

/** Colonne des modèles, fixe au défilement ; l'ombre pleine couvre les interstices entre cases, sous lesquels les notes défileraient. */
const MODEL_CELL = 'heatmap-model sticky left-0 z-10 bg-night-1 px-2 shadow-[0_0_0_3px_var(--color-night-1)]';

/**
 * Matrice « Qualité par catégorie de test » : une ligne par modèle, une colonne par catégorie puis la qualité globale ;
 * chaque case porte la note entière sur un fond coloré selon la note. Un clic sur un en-tête trie par cette colonne,
 * un second revient à l'ordre du classement. Le tableau défile horizontalement, la colonne des modèles restant fixe.
 */
export function CategoryHeatmap({
  models,
  categories,
  selected = null,
  onSelect,
}: {
  models: RankingModel[];
  categories: string[];
  /** Case mise en avant (filtre des réponses en cours). */
  selected?: HeatmapSelection | null;
  /** Rend les notes cliquables : un clic choisit la case, un second clic sur la même la désélectionne. */
  onSelect?: (selection: HeatmapSelection | null) => void;
}) {
  const hintId = useId();
  const [sortKey, setSortKey] = useState<string | null>(null);
  const columns: Column[] = useMemo(
    () => [
      ...categories.map((c) => ({ key: `category:${c}`, label: c, category: c, value: (m: RankingModel) => m.byCategory[c] ?? null })),
      { key: QUALITY_KEY, label: 'Qualité', category: null, value: (m: RankingModel) => m.quality },
    ],
    [categories],
  );
  const scored = useMemo(() => heatmapModels(models, categories), [models, categories]);
  const active = columns.find((c) => c.key === sortKey);
  const rows = useMemo(() => (active ? sortByColumn(scored, active.value) : scored), [scored, active]);

  if (categories.length === 0 || scored.length === 0) return <p className="m-0 py-10 text-center text-sm text-mute">Pas encore de note par catégorie.</p>;

  return (
    <div data-testid="category-heatmap">
      <p id={hintId} className="no-print m-0 mb-2 text-xs text-mute">
        Cliquez sur une catégorie ou sur « Qualité » pour trier les modèles ; un second clic revient à l'ordre du classement.
        {onSelect ? ' Cliquez sur une note pour afficher plus bas les réponses de ce modèle dans cette catégorie.' : null}
      </p>
      <div className="heatmap-scroll overflow-x-auto">
        <table aria-label="Qualité par catégorie de test" aria-describedby={hintId} className="heatmap-table border-separate border-spacing-[3px] text-xs">
          <thead>
            <tr className="text-mute">
              <th scope="col" className={`${MODEL_CELL} py-1.5 text-left align-bottom font-medium`}>
                Modèle
              </th>
              {columns.map((col) => {
                const sorted = col.key === sortKey;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={sorted ? 'descending' : undefined}
                    className={`heatmap-head min-w-[4.5rem] max-w-[8rem] p-0 align-bottom font-medium ${col.key === QUALITY_KEY ? 'heatmap-quality' : ''}`}
                  >
                    <button
                      type="button"
                      onClick={() => setSortKey(sorted ? null : col.key)}
                      title={sorted ? "Revenir à l'ordre du classement" : 'Trier par note décroissante'}
                      className={`w-full cursor-pointer rounded-md border-0 bg-transparent px-1.5 py-1.5 text-center text-xs leading-tight hover:bg-blue/10 focus-visible:outline-2 focus-visible:outline-blue ${
                        sorted ? 'font-semibold text-white' : 'font-medium text-ink'
                      }`}
                    >
                      {col.label}
                      {sorted ? (
                        <span aria-hidden="true" className="ml-0.5">
                          ↓
                        </span>
                      ) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.modelId}>
                <th scope="row" className={`${MODEL_CELL} py-1 text-left font-semibold whitespace-nowrap text-white`}>
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: m.color }} />
                    <span>
                      {m.name}
                      {m.providerName ? <small className="block font-mono text-[10px] font-normal text-mute">{m.providerName}</small> : null}
                    </span>
                  </span>
                </th>
                {columns.map((col) => {
                  const v = col.value(m);
                  const label = `${m.name} · ${col.label} : ${v === null ? 'pas de note' : `${score(v)} sur 100`}`;
                  const isSelected = selected !== null && selected.modelId === m.modelId && selected.category === col.category;
                  const clickable = onSelect !== undefined && v !== null;
                  return (
                    <td
                      key={col.key}
                      title={clickable ? `${label} · voir les réponses` : label}
                      aria-label={clickable ? undefined : label}
                      className={`heatmap-cell rounded-md text-center font-mono text-[13px] font-semibold ${clickable ? 'p-0' : 'px-1.5 py-2'} ${col.key === QUALITY_KEY ? 'heatmap-quality ring-1 ring-white/30 ring-inset' : ''} ${
                        v === null ? 'heatmap-empty bg-white/5 font-normal text-mute' : ''
                      } ${isSelected ? 'outline-2 outline-offset-1 outline-white' : ''}`}
                      // Couleur en ligne : la règle d'impression qui assombrit les textes clairs ne l'atteint pas.
                      style={v === null ? undefined : { backgroundColor: scoreColor(v), color: '#fff' }}
                    >
                      {clickable ? (
                        <button
                          type="button"
                          aria-label={label}
                          aria-pressed={isSelected}
                          onClick={() => onSelect(isSelected ? null : { modelId: m.modelId, category: col.category })}
                          className="w-full cursor-pointer rounded-md border-0 bg-transparent px-1.5 py-2 font-mono text-[13px] font-semibold text-inherit hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-white"
                        >
                          {score(v)}
                        </button>
                      ) : (
                        score(v)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Légende de l'échelle : dégradé 0 → 100 et case sans note. */}
      <div aria-label="Légende : échelle des notes" role="group" className="heatmap-legend mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-mute">
        <div className="flex w-44 flex-col gap-1">
          <span aria-hidden="true" className="block h-2.5 rounded-full" style={{ backgroundImage: LEGEND_GRADIENT }} />
          <span className="flex justify-between font-mono">
            <span>0</span>
            <span>50</span>
            <span>100</span>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span aria-hidden="true" className="heatmap-empty inline-flex h-4 w-6 items-center justify-center rounded bg-white/5">
            {DASH}
          </span>
          pas de note
        </div>
      </div>
    </div>
  );
}
