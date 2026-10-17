import { useId } from 'react';
import type { RunProgress } from '../../api/runs';
import { formatDuration } from '../tests/QuickTryPanel';
import { Card } from '../ui/Card';

type Activity = RunProgress['activity'][number];

const time = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });

function outcome(a: Activity): { text: string; tone: string } {
  if (a.status === 'done') return { text: a.totalMs === null ? 'Réponse reçue' : `Réponse en ${formatDuration(a.totalMs)}`, tone: 'text-ink' };
  if (a.status === 'timeout') return { text: 'Délai dépassé', tone: 'text-bad' };
  return { text: 'Erreur', tone: 'text-bad' };
}

/** Derniers résultats terminés, le plus récent en tête. */
export function ActivityFeed({ activity }: { activity: Activity[] }) {
  const headingId = useId();
  return (
    <Card className="flex min-h-0 flex-col">
      <h2 id={headingId} className="m-0 mb-2 font-display text-sm font-bold text-white">
        Fil d’activité
      </h2>
      {activity.length === 0 ? (
        <p className="m-0 text-sm text-mute">Les résultats apparaîtront ici dès la première réponse.</p>
      ) : (
        <ol aria-labelledby={headingId} className="m-0 max-h-[248px] list-none overflow-y-auto p-0">
          {activity.map((a) => {
            const o = outcome(a);
            return (
              <li key={a.resultId} className="flex items-center gap-2.5 border-b border-line py-2 text-[12.5px] last:border-b-0">
                <time dateTime={a.completedAt} className="w-[58px] shrink-0 font-mono text-[10.5px] text-mute">
                  {time(a.completedAt)}
                </time>
                <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: a.color, boxShadow: `0 0 8px ${a.color}` }} />
                <span className="min-w-0 flex-1">
                  <b className="block truncate font-semibold text-white">{a.modelName}</b>
                  <span className="block truncate text-mute">{a.testName}</span>
                </span>
                <span className={`shrink-0 ${o.tone}`}>{o.text}</span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
