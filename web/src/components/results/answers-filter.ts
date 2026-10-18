import type { HeatmapSelection } from './CategoryHeatmap';

/** Filtre des réponses : un modèle et une catégorie (`null` : tous / toutes), posé par les listes ou par la matrice. */
export type AnswersFilter = { modelId: string | null; category: string | null };
export const NO_FILTER: AnswersFilter = { modelId: null, category: null };

/** Case de la matrice correspondant au filtre (aucune sans modèle choisi). */
export const selectionOf = (filter: AnswersFilter): HeatmapSelection | null =>
  filter.modelId === null ? null : { modelId: filter.modelId, category: filter.category };
