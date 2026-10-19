import { Fragment } from 'react';
import { Link } from 'react-router-dom';

/** Étape du fil d'Ariane : un lien (`to`), une action (`onClick`, ex. refermer un éditeur) ou la page courante. */
export type Crumb = { label: string; to?: string; onClick?: () => void };

const STEP = 'text-mute no-underline hover:text-white';

/**
 * Fil d'Ariane des pages de détail, toujours au même endroit : première ligne de la page, au-dessus du titre, à gauche.
 * La dernière étape est la page courante.
 */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Fil d’Ariane" className="mb-2 font-mono text-xs text-mute">
      <ol className="m-0 flex list-none flex-wrap items-baseline gap-x-1.5 p-0">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <Fragment key={`${i}-${c.label}`}>
              {i > 0 ? (
                <li aria-hidden="true" className="text-mute/70">
                  {' / '}
                </li>
              ) : null}
              <li className="min-w-0 [overflow-wrap:anywhere]">
                {c.to && !last ? (
                  <Link to={c.to} className={STEP}>
                    {c.label}
                  </Link>
                ) : c.onClick && !last ? (
                  <button type="button" onClick={c.onClick} className={`cursor-pointer border-0 bg-transparent p-0 font-mono text-xs ${STEP}`}>
                    {c.label}
                  </button>
                ) : (
                  <span aria-current={last ? 'page' : undefined} className={last ? 'text-ink' : undefined}>
                    {c.label}
                  </span>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
