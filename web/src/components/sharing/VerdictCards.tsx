import type { PublicVerdict } from '../../api/public-share';

/** Verdicts rédigés par l'Admin : le premier est mis en avant ; sans modèle, la carte n'a que son libellé et son texte. */
export function VerdictCards({ verdicts }: { verdicts: PublicVerdict[] }) {
  if (verdicts.length === 0) return null;
  return (
    <ul aria-label="Verdicts" className="m-0 grid list-none gap-3.5 p-0 sm:grid-cols-2 lg:grid-cols-3">
      {verdicts.map((v, i) => (
        <li
          key={i}
          className={`card-surface flex flex-col gap-2 p-5 ${i === 0 ? 'border-orange/55 bg-gradient-to-b from-orange/20 to-night-1/75 shadow-[0_0_40px_-12px_rgba(240,99,31,0.6)]' : ''}`}
        >
          <span className={`font-mono text-[11px] font-semibold ${i === 0 ? 'text-peach' : 'text-sky'}`}>{v.label}</span>
          {v.model ? (
            <strong className="flex items-center gap-2 font-display text-2xl leading-tight font-extrabold text-white">
              <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: v.model.color, boxShadow: `0 0 10px ${v.model.color}` }} />
              {v.model.name}
            </strong>
          ) : null}
          <p className="m-0 text-sm leading-relaxed whitespace-pre-line text-ink">{v.text}</p>
        </li>
      ))}
    </ul>
  );
}
