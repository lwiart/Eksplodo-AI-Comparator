import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { messageForError } from '../api/messages';
import { RUNS_KEY, listRuns } from '../api/runs';
import { useAuth } from '../auth/AuthProvider';
import { formatDate } from '../components/catalog/format';
import { Card } from '../components/ui/Card';
import { RunStatusChip } from '../components/runs/RunStatusChip';
import { Chip } from '../components/ui/Chip';
import { PRIMARY_LINK, finishedCalls, plural, usd } from '../lib/format';

/** Liste des séries, la plus récente en tête ; l'Admin peut en lancer une nouvelle. */
export function RunsPage() {
  const { user } = useAuth();
  const runs = useQuery({ queryKey: RUNS_KEY, queryFn: listRuns });
  const isAdmin = user?.role === 'admin';

  return (
    <div className="mx-auto max-w-[1100px]">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">Séries</h1>
          <p className="mt-2 mb-0 max-w-prose text-sm text-mute">
            Une série soumet les mêmes tests à plusieurs modèles et mesure leurs réponses : vitesse, coût, fiabilité.
          </p>
        </div>
        {isAdmin ? (
          <Link to="/series/nouvelle" className={PRIMARY_LINK}>
            Lancer une série
          </Link>
        ) : null}
      </header>

      {runs.isError ? (
        <p role="alert" className="text-sm text-bad">
          {messageForError(runs.error)}
        </p>
      ) : runs.isPending ? (
        <p className="text-sm text-mute">Chargement des séries…</p>
      ) : runs.data.length === 0 ? (
        <Card className="py-10 text-center">
          <p className="m-0 text-sm text-mute">
            Aucune série pour l’instant.{isAdmin ? ' Lancez-en une pour comparer des modèles sur vos tests.' : ' Elles apparaîtront ici dès qu’un Admin en aura lancé une.'}
          </p>
        </Card>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-mute">
                <th className="px-4 py-3 font-medium">Série</th>
                <th className="px-4 py-3 font-medium">Statut</th>
                <th className="px-4 py-3 font-medium">Suite</th>
                <th className="px-4 py-3 font-medium">Modèles × répétitions</th>
                <th className="px-4 py-3 font-medium">Appels terminés</th>
                <th className="px-4 py-3 text-right font-medium">Coût</th>
                <th className="px-4 py-3 font-medium">Créée le</th>
                <th className="px-4 py-3 font-medium">Terminée le</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-4 py-3">
                    <Link to={`/series/${r.id}`} className="font-semibold text-white no-underline hover:underline">
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <RunStatusChip status={r.status} />
                  </td>
                  <td className={`px-4 py-3 ${r.suiteName ? 'text-ink' : 'text-mute'}`}>{r.suiteName ?? 'Tests à la carte'}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-ink">
                    {plural(r.modelCount, 'modèle', 'modèles')} × {r.repetitions}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs whitespace-nowrap text-ink">
                    {finishedCalls(r.counts)} / {r.counts.total}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs whitespace-nowrap text-ink">{usd(r.modelsCostUsd + r.judgeCostUsd)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-ink">{formatDate(r.createdAt)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-mute">{r.completedAt ? formatDate(r.completedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
