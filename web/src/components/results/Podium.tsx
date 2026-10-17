import type { RankedRow } from '../../lib/ranking';
import { score } from './format';

const STEP_STYLE = [
  'h-[200px] border-orange/55 bg-gradient-to-b from-orange/30 to-orange/5 shadow-[0_0_40px_-10px_rgba(240,99,31,0.6)]',
  'h-[160px] border-line bg-night-0/45',
  'h-[130px] border-line bg-night-0/45',
];

/** Les trois premiers du classement ; le premier au centre. Un modèle sans qualité n'y figure jamais. */
export function Podium({ rows }: { rows: RankedRow[] }) {
  const top = rows.filter((r) => r.rank !== null).slice(0, 3);
  if (top.length === 0) {
    return (
      <p className="m-0 rounded-xl border border-line bg-night-0/45 px-4 py-6 text-center text-sm text-mute">
        Aucun modèle noté pour l’instant : la qualité, donc le podium, apparaît dès qu’une réponse est notée.
      </p>
    );
  }
  // Ordre d'affichage : 2e, 1er, 3e (les positions manquantes sont simplement omises).
  const display = [1, 0, 2].filter((i) => top[i] !== undefined);
  return (
    <ol aria-label="Podium" className="m-0 grid list-none grid-cols-3 items-end gap-2.5 p-0">
      {display.map((i) => {
        const { model, rank, global } = top[i]!;
        return (
          <li key={model.modelId} className={`relative flex flex-col items-center rounded-[14px] border px-2.5 py-3 text-center ${STEP_STYLE[i]}`}>
            <span className="font-display text-[28px] leading-none font-extrabold text-white">{rank}</span>
            <span className="mt-1.5 flex items-center gap-1.5 font-display text-[13px] font-bold text-white">
              <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: model.color }} />
              {model.name}
            </span>
            <span className="font-mono text-[11px] text-mute">{model.providerName}</span>
            <span className={`mt-auto pt-2 font-display text-[22px] font-extrabold ${i === 0 ? 'text-peach' : 'text-sky'}`}>{score(global)}</span>
          </li>
        );
      })}
    </ol>
  );
}
