import { useId } from 'react';
import type { RankedRow } from '../../lib/ranking';
import { formatDuration } from '../tests/QuickTryPanel';
import { Card } from '../ui/Card';
import { DASH, costPerAnswer, reliabilityPercent, score, tokensPerSecond } from './format';

const TH = 'px-4 py-3 font-medium';

/** Classement détaillé : rang, score global et mesures par modèle ; « — » pour une valeur nulle. */
export function RankingTable({ rows, judgeName }: { rows: RankedRow[]; judgeName?: string | null }) {
  const headingId = useId();
  return (
    <Card className="p-0">
      <div className="px-4 pt-4">
        <h2 id={headingId} className="m-0 font-display text-base font-bold text-white">
          Classement détaillé
        </h2>
        <p className="mt-1 mb-0 text-xs text-mute">
          Médianes calculées sur les réponses réussies.{judgeName ? ` Juge : ${judgeName}.` : ''}
        </p>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table aria-labelledby={headingId} className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-mute">
              <th scope="col" className={TH}>Rang</th>
              <th scope="col" className={TH}>Modèle</th>
              <th scope="col" className={TH}>Score global</th>
              <th scope="col" className={`${TH} text-right`}>Qualité</th>
              <th scope="col" className={`${TH} text-right`}>Premier token médian</th>
              <th scope="col" className={`${TH} text-right`}>Débit médian</th>
              <th scope="col" className={`${TH} text-right`}>Coût moyen</th>
              <th scope="col" className={`${TH} text-right`}>Fiabilité</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ model: m, rank, global }) => (
              <tr key={m.modelId} className="border-t border-line whitespace-nowrap hover:bg-blue/5">
                <td className="px-4 py-3 font-display text-base font-extrabold text-white">{rank ?? DASH}</td>
                <th scope="row" className="px-4 py-3 text-left font-semibold text-white">
                  <span className="flex items-center gap-2.5">
                    <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: m.color, boxShadow: `0 0 10px ${m.color}` }} />
                    <span>
                      {m.name}
                      <small className="block font-mono text-[11px] font-normal text-mute">{m.providerName}</small>
                    </span>
                  </span>
                </th>
                <td className="px-4 py-3">
                  <span className="flex items-center gap-2.5">
                    <span aria-hidden="true" className="block h-2 w-[90px] overflow-hidden rounded-full bg-white/10">
                      <span className="block h-full rounded-full bg-gradient-to-r from-orange to-peach transition-[width] duration-500" style={{ width: `${(global ?? 0) * 10}%` }} />
                    </span>
                    <b className="font-mono text-xs text-white">{score(global)}</b>
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs text-ink">{score(m.quality)}</td>
                <td className="px-4 py-3 text-right font-mono text-xs text-ink">{m.raw.medianTtftMs === null ? DASH : formatDuration(m.raw.medianTtftMs)}</td>
                <td className="px-4 py-3 text-right font-mono text-xs text-ink">{tokensPerSecond(m.raw.medianTokensPerS)}</td>
                <td className="px-4 py-3 text-right font-mono text-xs text-ink">{costPerAnswer(m.raw.meanCostUsd)}</td>
                <td className="px-4 py-3 text-right font-mono text-xs text-ink">{reliabilityPercent(m.reliability)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
