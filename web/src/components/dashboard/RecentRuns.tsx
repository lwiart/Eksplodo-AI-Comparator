import { Link } from 'react-router-dom';
import type { Dashboard } from '../../api/dashboard';
import { usd } from '../../lib/format';
import { RunStatusChip } from '../runs/RunStatusChip';
import { Card } from '../ui/Card';

/** Dernières séries : le vainqueur d'une série non terminée est provisoire et signalé comme tel. */
export function RecentRuns({ runs }: { runs: Dashboard['recentRuns'] }) {
  return (
    <Card className="overflow-x-auto p-0">
      <h2 className="m-0 px-4 pt-4 font-display text-lg font-bold text-white">Dernières séries</h2>
      {runs.length === 0 ? (
        <p className="m-0 px-4 pt-3 pb-5 text-sm text-mute">Aucune série pour l’instant.</p>
      ) : (
        <table className="table-sticky-first mt-2 w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-mute">
              <th className="px-4 py-2 font-medium">Série</th>
              <th className="px-4 py-2 font-medium">Suite</th>
              <th className="px-4 py-2 font-medium">Modèles</th>
              <th className="px-4 py-2 font-medium">Vainqueur</th>
              <th className="px-4 py-2 text-right font-medium">Coût</th>
              <th className="px-4 py-2 font-medium">Statut</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className="px-4 py-3">
                  <Link to={`/series/${r.id}`} className="font-semibold text-white no-underline hover:underline">
                    {r.name}
                  </Link>
                </td>
                <td className={`px-4 py-3 ${r.suiteName ? 'text-ink' : 'text-mute'}`}>{r.suiteName ?? 'Tests à la carte'}</td>
                <td className="px-4 py-3 text-ink">{r.modelCount}</td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {r.winner ? (
                    <span className="inline-flex items-center gap-2 text-ink">
                      <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ background: r.winner.color }} />
                      {r.winner.name}
                      {r.status !== 'completed' ? <span className="text-xs text-mute">provisoire</span> : null}
                    </span>
                  ) : (
                    <span className="text-mute">-</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap text-ink">{usd(r.costUsd)}</td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <RunStatusChip status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
