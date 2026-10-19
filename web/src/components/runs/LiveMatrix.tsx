import { useId } from 'react';
import type { MatrixCell, RunProgress } from '../../api/runs';
import { Card } from '../ui/Card';

const count = (n: number, one: string, many = one) => `${n} ${n > 1 ? many : one}`;

/** Libellé lu par les lecteurs d'écran (et en infobulle) : le détail des appels d'une case. */
export function cellLabel(c: MatrixCell): string {
  const total = c.pending + c.running + c.done + c.failed + c.unsupported + c.truncated;
  if (total > 0 && c.unsupported === total) return 'non supporté';
  const parts = [
    c.done > 0 ? count(c.done, 'réussi', 'réussis') : null,
    c.running > 0 ? count(c.running, 'en cours') : null,
    c.failed > 0 ? count(c.failed, 'en erreur') : null,
    c.truncated > 0 ? count(c.truncated, 'tronqué', 'tronqués') : null,
    c.pending > 0 ? count(c.pending, 'à faire') : null,
    c.unsupported > 0 ? count(c.unsupported, 'non supporté', 'non supportés') : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'aucun appel';
}

// Une case = les appels d'un test pour un modèle (toutes répétitions) : un segment par état, proportionnel au nombre.
// Couleurs : réussi vert, en cours bleu, en erreur rouge, tronquée marron.
const SEGMENTS: { key: keyof Omit<MatrixCell, 'modelId'>; className: string; legend: string }[] = [
  { key: 'done', className: 'bg-good', legend: 'Réussi' },
  { key: 'running', className: 'bg-blue motion-safe:animate-pulse', legend: 'En cours' },
  { key: 'failed', className: 'bg-run-error', legend: 'Erreur' },
  { key: 'truncated', className: 'bg-truncated', legend: 'Tronquée (limite de tokens)' },
  { key: 'pending', className: 'bg-transparent', legend: 'À faire' },
  { key: 'unsupported', className: 'bg-mute/30', legend: 'Non supporté' },
];

function Cell({ cell }: { cell: MatrixCell }) {
  return (
    <span className="flex h-3.5 w-full min-w-6 overflow-hidden rounded-[4px] border border-line-strong">
      {SEGMENTS.map((s) =>
        cell[s.key] > 0 ? <span key={s.key} className={`h-full ${s.className}`} style={{ flexGrow: cell[s.key] }} /> : null,
      )}
    </span>
  );
}

/** Progression par test (lignes) et par modèle (colonnes). */
export function LiveMatrix({ matrix, models }: Pick<RunProgress, 'matrix' | 'models'>) {
  const headingId = useId();
  const names = new Map(models.map((m) => [m.id, m.name] as const));
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 id={headingId} className="m-0 font-display text-sm font-bold text-white">
          Progression par test et par modèle
        </h2>
        <ul aria-label="Légende" className="m-0 ml-auto flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-[11px] text-mute">
          {SEGMENTS.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-[3px] border border-line-strong ${s.className.replace(' motion-safe:animate-pulse', '')}`} />
              {s.legend}
            </li>
          ))}
        </ul>
      </div>
      <div className="overflow-x-auto">
        <table aria-labelledby={headingId} className="table-sticky-first w-full border-collapse text-xs">
          <thead>
            <tr>
              <th scope="col" className="w-px">
                <span className="sr-only">Test</span>
              </th>
              {models.map((m) => (
                <th key={m.id} scope="col" className="px-1.5 pb-2 text-left font-medium text-ink">
                  <span className="flex max-w-36 items-center gap-1.5">
                    <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: m.color }} />
                    <span className="truncate" title={m.name}>
                      {m.name}
                    </span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map((row) => (
              <tr key={row.runTestId}>
                <th scope="row" className="max-w-48 truncate py-1 pr-3 text-left font-normal text-ink" title={row.testName}>
                  {row.testName}
                </th>
                {row.cells.map((c) => {
                  const label = `${row.testName}, ${names.get(c.modelId) ?? c.modelId} : ${cellLabel(c)}`;
                  return (
                    <td key={c.modelId} className="px-1.5 py-1">
                      <span role="img" aria-label={label} title={label} className="block">
                        <Cell cell={c} />
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
