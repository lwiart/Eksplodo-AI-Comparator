import { useQuery } from '@tanstack/react-query';
import { messageForError } from '../../api/messages';
import { getSpread, spreadKey } from '../../api/scoring';
import { score } from './format';

/** Écarts entre évaluateurs d'un test (Admin) : moyenne, écart-type et note de chaque évaluateur, du plus divisé au plus consensuel. */
export function RaterSpread({ runId, runTestId }: { runId: string; runTestId: string }) {
  const spread = useQuery({ queryKey: spreadKey(runId), queryFn: () => getSpread(runId) });
  if (spread.isError)
    return (
      <p role="alert" className="text-sm text-bad">
        {messageForError(spread.error)}
      </p>
    );
  if (spread.isPending) return <p className="text-sm text-mute">Chargement des écarts…</p>;
  const items = spread.data
    .filter((i) => i.runTestId === runTestId && i.raters > 0)
    .sort((a, b) => (b.stdDev ?? 0) - (a.stdDev ?? 0));
  if (items.length === 0) return <p className="m-0 text-sm text-mute">Aucune note manuelle enregistrée pour ce test.</p>;
  return (
    <div className="overflow-x-auto">
      <table aria-label="Écarts entre évaluateurs" className="table-sticky-first w-full border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-[11px] text-mute">
            <th scope="col" className="px-2 py-2 font-medium">Modèle</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">Évaluateurs</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">Moyenne</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">Écart-type</th>
            <th scope="col" className="px-2 py-2 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.resultId} className="border-t border-line align-top">
              <th scope="row" className="px-2 py-2 text-left font-semibold text-white">{i.modelName}</th>
              <td className="px-2 py-2 text-right font-mono">{i.raters}</td>
              <td className="px-2 py-2 text-right font-mono text-white">{score(i.mean)}</td>
              <td className="px-2 py-2 text-right font-mono text-peach">{score(i.stdDev)}</td>
              <td className="px-2 py-2">
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {i.scores.map((s, k) => (
                    <li key={k} className="text-xs text-mute">
                      <span className="text-ink">{s.userName}</span> <span className="font-mono font-semibold text-white">{s.score}</span>
                      {s.comment ? <span> : {s.comment}</span> : null}
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
