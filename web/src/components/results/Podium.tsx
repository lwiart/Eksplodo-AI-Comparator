import type { RankedRow } from '../../lib/ranking';
import { score } from './format';

/**
 * Hauteur de chaque marche, en part de la hauteur du podium : la 1re touche le haut de la zone, la 2e et la 3e un peu
 * moins hautes (escalier, alignées en bas). Une hauteur minimale garde la place du contenu sur une zone trop basse.
 */
const STEP_STYLE = [
  'h-full min-h-[150px] border-orange/55 bg-gradient-to-b from-orange/30 to-orange/5 shadow-[0_0_40px_-10px_rgba(240,99,31,0.6)]',
  'h-[84%] min-h-[130px] border-line bg-night-0/45',
  'h-[70%] min-h-[120px] border-line bg-night-0/45',
];

/**
 * Les trois premiers du classement ; le premier au centre. Un modèle sans qualité n'y figure jamais.
 * Le podium occupe toute la hauteur de son conteneur (à lui de la fixer, au moins 200 px) ; sur une zone large, les
 * marches gardent une largeur raisonnable et restent centrées.
 */
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
    <ol aria-label="Podium" className="m-0 mx-auto flex h-full min-h-[200px] w-full max-w-[660px] list-none items-end justify-center gap-2.5 p-0">
      {display.map((i) => {
        const { model, rank, global } = top[i]!;
        return (
          <li
            key={model.modelId}
            className={`relative flex max-w-[210px] min-w-0 flex-1 basis-0 flex-col items-center rounded-[14px] border px-2.5 py-3 text-center ${STEP_STYLE[i]}`}
          >
            <span className="font-display text-[28px] leading-none font-extrabold text-white">{rank}</span>
            <span className="mt-1.5 flex max-w-full items-center gap-1.5 font-display text-[13px] font-bold text-white">
              <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: model.color }} />
              <span className="min-w-0 break-words">{model.name}</span>
            </span>
            <span className="max-w-full font-mono text-[11px] break-words text-mute">{model.providerName}</span>
            <span className={`mt-auto pt-2 font-display text-[22px] font-extrabold ${i === 0 ? 'text-peach' : 'text-sky'}`}>{score(global)}</span>
          </li>
        );
      })}
    </ol>
  );
}
