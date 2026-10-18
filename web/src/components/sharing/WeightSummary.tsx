import type { Weights } from '../../api/runs';
import { DEFINITION_LABELS, DEFINITIONS } from '../results/definitions';
import { InfoTip } from '../ui/InfoTip';

const KEYS = ['quality', 'speed', 'cost', 'reliability'] as const;

/**
 * Synthèse de la pondération du score global, sous le podium : chaque critère avec sa définition ; ceux à 0 % sont omis,
 * comme le coût quand le lien masque les coûts (la page n'en dit alors rien).
 */
export function WeightSummary({ weights, hideCost = false }: { weights: Weights; hideCost?: boolean }) {
  const items = KEYS.filter((k) => weights[k] > 0 && !(hideCost && k === 'cost'));
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <p className="m-0 font-mono text-[11px] text-mute">Pondération du score global</p>
      <ul aria-label="Pondération du score global" className="m-0 flex list-none flex-wrap items-center justify-center gap-y-1.5 p-0 text-sm text-ink">
        {items.map((k, i) => (
          <li key={k} className="flex items-center gap-1.5">
            {i > 0 ? (
              <span aria-hidden="true" className="mr-2.5 ml-1 text-line-strong">
                |
              </span>
            ) : null}
            <span>{DEFINITION_LABELS[k]}</span>
            <InfoTip label={DEFINITION_LABELS[k]} align={i >= items.length - 1 && items.length > 1 ? 'right' : 'left'}>
              {DEFINITIONS[k]}
            </InfoTip>
            <b className="font-mono font-semibold text-white">{weights[k]} %</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
