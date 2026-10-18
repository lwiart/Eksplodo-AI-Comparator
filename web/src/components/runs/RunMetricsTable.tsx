import { useId } from 'react';
import type { ResultRow } from '../../api/runs';
import { formatNumber, formatPricePair } from '../catalog/format';
import { formatDuration } from '../tests/QuickTryPanel';
import { Card } from '../ui/Card';

export type ModelMetrics = {
  modelId: string;
  modelName: string;
  color: string;
  successes: number;
  /** Résultats en erreur ou hors délai. */
  errors: number;
  medianTtftMs: number | null;
  medianTokensPerS: number | null;
  /** Coût moyen d'une réponse réussie (parmi celles dont le coût est connu). */
  meanCostUsd: number | null;
};

/** Médiane (moyenne des deux valeurs centrales pour un nombre pair) ; `null` sans valeur. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const known = (values: (number | null)[]) => values.filter((v): v is number => v !== null);

/** Mesures par modèle, dans l'ordre d'apparition des modèles ; les médianes portent sur les réponses réussies. */
export function modelMetrics(rows: ResultRow[]): ModelMetrics[] {
  const byModel = new Map<string, ResultRow[]>();
  for (const r of rows) {
    const list = byModel.get(r.modelId);
    if (list) list.push(r);
    else byModel.set(r.modelId, [r]);
  }
  return [...byModel.values()].map((list) => {
    const first = list[0]!;
    const done = list.filter((r) => r.status === 'done');
    const costs = known(done.map((r) => r.costUsd));
    return {
      modelId: first.modelId,
      modelName: first.modelName,
      color: first.color,
      successes: done.length,
      errors: list.filter((r) => r.status === 'error' || r.status === 'timeout').length,
      medianTtftMs: median(known(done.map((r) => r.ttftMs))),
      medianTokensPerS: median(known(done.map((r) => r.tokensPerS))),
      meanCostUsd: costs.length === 0 ? null : Math.round((costs.reduce((a, b) => a + b, 0) / costs.length) * 1e6) / 1e6,
    };
  });
}

const dash = '—';

/** Tarif du catalogue d'un modèle, en dollars par million de tokens. */
export type ModelPrice = { inputPricePerM: number; outputPricePerM: number };

/** Tableau des mesures par modèle d'une série terminée, avec le tarif actuel de chaque modèle au catalogue. */
export function RunMetricsTable({ rows, prices }: { rows: ResultRow[]; prices?: Map<string, ModelPrice> }) {
  const headingId = useId();
  const metrics = modelMetrics(rows);
  return (
    <Card className="p-0">
      <div className="px-4 pt-4">
        <h2 id={headingId} className="m-0 font-display text-base font-bold text-white">
          Métriques par modèle
        </h2>
        <p className="mt-1 mb-0 text-xs text-mute">Médianes calculées sur les réponses réussies. Tarifs : ceux du catalogue aujourd’hui.</p>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table aria-labelledby={headingId} className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-mute">
              <th scope="col" className="px-4 py-3 font-medium">Modèle</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Réussis</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Erreurs</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Premier token médian</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Débit médian</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Coût moyen par réponse</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Tarif entrée / sortie (1 M tokens)</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.modelId} className="border-t border-line whitespace-nowrap">
                <th scope="row" className="px-4 py-3 text-left font-semibold text-white">
                  <span className="flex items-center gap-2.5">
                    <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: m.color }} />
                    {m.modelName}
                  </span>
                </th>
                <td className="px-4 py-3 text-right font-mono text-xs text-good">{m.successes}</td>
                <td className={`px-4 py-3 text-right font-mono text-xs ${m.errors > 0 ? 'text-bad' : 'text-mute'}`}>{m.errors}</td>
                <td className="px-4 py-3 text-right font-mono text-xs text-ink">{m.medianTtftMs === null ? dash : formatDuration(m.medianTtftMs)}</td>
                <td className="px-4 py-3 text-right font-mono text-xs text-ink">
                  {m.medianTokensPerS === null ? dash : `${formatNumber(Math.round(m.medianTokensPerS * 10) / 10)} tokens/s`}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs text-ink">
                  {m.meanCostUsd === null ? dash : `${formatNumber(Number(m.meanCostUsd.toFixed(6)))} $`}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs text-ink">
                  {formatPricePair(prices?.get(m.modelId)?.inputPricePerM ?? null, prices?.get(m.modelId)?.outputPricePerM ?? null) ?? dash}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
