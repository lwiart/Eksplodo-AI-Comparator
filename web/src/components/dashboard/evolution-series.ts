import type { Evolution } from '../../api/dashboard';

/** Un modèle sans aucune qualité sur la période n'a rien à tracer. */
export const plottedSeries = (series: Evolution['series']) => series.filter((s) => s.points.some((p) => p !== null));
