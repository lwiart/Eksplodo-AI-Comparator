// Mises en forme des notes et mesures de la vue résultats.
import { formatNumber } from '../catalog/format';

export const DASH = '—';

/** Note sur 10 à la française, un à deux décimales ; « — » quand elle est nulle. */
export const score = (n: number | null): string => (n === null ? DASH : n.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 2 }));

/** Fiabilité (note sur 10 = réussis ÷ terminés × 10) affichée en pourcentage. */
export const reliabilityPercent = (n: number | null): string => (n === null ? DASH : `${formatNumber(Math.round(n * 10))} %`);

export const tokensPerSecond = (n: number | null): string => (n === null ? DASH : `${formatNumber(Math.round(n * 10) / 10)} tokens/s`);

export const costPerAnswer = (n: number | null): string => (n === null ? DASH : `${formatNumber(Number(n.toFixed(6)))} $`);

/** Rang à la française : « 1ᵉʳ sur 6 », « 2ᵉ sur 6 ». */
export const rankLabel = ({ rank, of }: { rank: number; of: number }): string => `${rank}${rank === 1 ? 'ᵉʳ' : 'ᵉ'} sur ${of}`;

/** Délai du premier token : en millisecondes sous la seconde, sinon en secondes. */
export const ttft = (ms: number | null): string =>
  ms === null ? DASH : ms < 1000 ? `${formatNumber(Math.round(ms))} ms` : `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;
