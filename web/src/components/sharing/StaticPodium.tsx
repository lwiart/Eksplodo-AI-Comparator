import type { RankedRow } from '../../lib/ranking';
import { score } from '../results/format';

/**
 * Podium de la version imprimable : HTML et CSS purs (ni canvas, ni transition, ni lueur), visible seulement à l'impression
 * (classe `print-only`). Les trois premiers modèles classés, dans l'ordre ; un modèle sans rang n'y figure jamais.
 */
export function StaticPodium({ rows }: { rows: RankedRow[] }) {
  const top = rows.filter((r) => r.rank !== null).slice(0, 3);
  if (top.length === 0) return null;
  return (
    <div className="print-only">
      <ol aria-label="Podium imprimable" className="m-0 grid list-none grid-cols-3 gap-3 p-0">
        {top.map(({ model, rank, global }) => (
          <li key={model.modelId} className="rounded-xl border px-3 py-3 text-center">
            <span className="block font-display text-2xl leading-none font-extrabold">{rank}</span>
            <span className="mt-1.5 flex items-center justify-center gap-1.5 font-display text-sm font-bold">
              <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: model.color }} />
              {model.name}
            </span>
            <span className="block font-mono text-[11px]">{model.providerName}</span>
            <span className="mt-1.5 block font-display text-xl font-extrabold">{score(global)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
