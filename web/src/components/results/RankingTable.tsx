import { useId, useState } from 'react';
import type { RankedRow } from '../../lib/ranking';
import { ariaSort, nextSort, sortBy, type SortState } from '../../lib/sort';
import { SortButton } from '../ui/SortButton';
import { formatDuration } from '../tests/QuickTryPanel';
import { Card } from '../ui/Card';
import { InfoTip } from '../ui/InfoTip';
import { DEFINITION_LABELS, DEFINITIONS, type DefinitionKey } from './definitions';
import { DASH, costPerAnswer, reliabilityPercent, score, tokensPerSecond } from './format';

const TH = 'px-4 py-3 font-medium';

type ColumnKey = 'rank' | 'model' | 'global' | 'quality' | 'ttft' | 'tps' | 'cost' | 'reliability';

/** Valeur de tri de chaque colonne, et sens du premier clic (le meilleur d'abord). */
const COLUMNS: Record<ColumnKey, { value: (r: RankedRow) => number | string | null; first: 'asc' | 'desc' }> = {
  rank: { value: (r) => r.rank, first: 'asc' },
  model: { value: (r) => r.model.name, first: 'asc' },
  global: { value: (r) => r.global, first: 'desc' },
  quality: { value: (r) => r.model.quality, first: 'desc' },
  ttft: { value: (r) => r.model.raw.medianTtftMs, first: 'asc' },
  tps: { value: (r) => r.model.raw.medianTokensPerS, first: 'desc' },
  cost: { value: (r) => r.model.raw.meanCostUsd, first: 'asc' },
  reliability: { value: (r) => r.model.reliability, first: 'desc' },
};

/**
 * En-tête de colonne triable, avec une icône d'aide éventuelle. Le nom accessible reste le seul intitulé (`aria-label`) :
 * la bulle a son propre bouton et n'est pas relue à chaque cellule.
 */
function SortHeader({
  title,
  column,
  sort,
  onSort,
  className,
  help,
  helpLabel,
  align = 'left',
}: {
  title: string;
  column: ColumnKey;
  sort: SortState<ColumnKey>;
  onSort(column: ColumnKey): void;
  className: string;
  help?: string;
  helpLabel?: string;
  align?: 'left' | 'right';
}) {
  return (
    <th scope="col" aria-label={title} aria-sort={ariaSort(sort, column)} className={className}>
      <span className={`inline-flex items-center gap-1.5 ${align === 'right' ? 'justify-end' : ''}`}>
        <SortButton dir={sort?.key === column ? sort.dir : null} onClick={() => onSort(column)} align={align}>
          {title}
        </SortButton>
        {help && helpLabel ? (
          <InfoTip label={helpLabel} align={align}>
            {help}
          </InfoTip>
        ) : null}
      </span>
    </th>
  );
}

/** Définitions imprimées sous le tableau : les bulles d'aide sont masquées à l'impression. */
function PrintedDefinitions({ hideCosts }: { hideCosts: boolean }) {
  const keys = (Object.keys(DEFINITIONS) as DefinitionKey[]).filter((k) => !(hideCosts && k === 'cost'));
  return (
    <section aria-label="Définitions" className="print-only ranking-definitions px-4 pb-4">
      <h3 className="m-0 mb-2 font-display text-sm font-bold text-white">Définitions</h3>
      <dl className="m-0 text-xs text-ink">
        {keys.map((k) => (
          <div key={k} className="mb-1.5">
            <dt className="inline font-semibold text-white">{DEFINITION_LABELS[k]} : </dt>
            <dd className="m-0 inline">{DEFINITIONS[k]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * Classement détaillé : rang, score global et mesures par modèle ; « — » pour une valeur nulle ; `hideCosts` retire la colonne coût.
 * Icônes d'aide sur les en-têtes ; à l'impression, le tableau se compacte (theme.css) et les définitions s'affichent dessous.
 */
export function RankingTable({ rows: ranked, judgeName, hideCosts = false }: { rows: RankedRow[]; judgeName?: string | null; hideCosts?: boolean }) {
  const headingId = useId();
  // Tri au clic sur un en-tête : le meilleur d'abord, puis l'autre sens, puis l'ordre du classement.
  const [sort, setSort] = useState<SortState<ColumnKey>>(null);
  const onSort = (column: ColumnKey) => setSort((s) => nextSort(s, column, COLUMNS[column].first));
  const rows = sort ? sortBy(ranked, COLUMNS[sort.key].value, sort.dir) : ranked;
  const header = { sort, onSort };
  return (
    <Card className="p-0">
      <div className="px-4 pt-4">
        <h2 id={headingId} className="m-0 font-display text-base font-bold text-white">
          Classement détaillé
        </h2>
        <p className="mt-1 mb-0 text-xs text-mute">
          Médianes calculées sur les réponses réussies.{judgeName ? ` Juge : ${judgeName}.` : ''}
        </p>
      </div>
      <div className="ranking-scroll mt-3 overflow-x-auto">
        <table aria-labelledby={headingId} className="table-sticky-rank ranking-table w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-mute">
              <SortHeader title="Rang" column="rank" {...header} className={`${TH} ranking-col-rank`} />
              <SortHeader title="Modèle" column="model" {...header} className={`${TH} ranking-col-model`} />
              <SortHeader title="Score global" column="global" {...header} helpLabel={DEFINITION_LABELS.global} help={DEFINITIONS.global} className={TH} />
              <SortHeader title="Qualité" column="quality" {...header} helpLabel={DEFINITION_LABELS.quality} help={DEFINITIONS.quality} className={`${TH} text-right`} align="right" />
              <SortHeader title="Premier token médian" column="ttft" {...header} helpLabel="Premier token (vitesse)" help={DEFINITIONS.speed} className={`${TH} text-right`} align="right" />
              <SortHeader title="Débit médian" column="tps" {...header} helpLabel="Débit (vitesse)" help={DEFINITIONS.speed} className={`${TH} text-right`} align="right" />
              {hideCosts ? null : (
                <SortHeader title="Coût moyen" column="cost" {...header} helpLabel={DEFINITION_LABELS.cost} help={DEFINITIONS.cost} className={`${TH} text-right`} align="right" />
              )}
              <SortHeader title="Fiabilité" column="reliability" {...header} helpLabel={DEFINITION_LABELS.reliability} help={DEFINITIONS.reliability} className={`${TH} text-right`} align="right" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ model: m, rank, global }) => (
              <tr key={m.modelId} className="border-t border-line whitespace-nowrap hover:bg-blue/5">
                <td className="px-4 py-3 font-display text-base font-extrabold text-white">{rank ?? DASH}</td>
                <th scope="row" className="px-4 py-3 text-left font-semibold text-white">
                  <span className="flex items-center gap-2.5">
                    <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: m.color, boxShadow: `0 0 10px ${m.color}` }} />
                    <span>
                      {m.name}
                      <small className="block font-mono text-[11px] font-normal text-mute">{m.providerName}</small>
                    </span>
                  </span>
                </th>
                <td className="px-4 py-3">
                  <span className="flex items-center gap-2.5">
                    <span aria-hidden="true" className="ranking-bar block h-2 w-[90px] overflow-hidden rounded-full bg-white/10">
                      <span className="block h-full rounded-full bg-gradient-to-r from-orange to-peach transition-[width] duration-500" style={{ width: `${Math.min(100, global ?? 0)}%` }} />
                    </span>
                    <b className="font-mono text-xs text-white">{score(global)}</b>
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs text-ink">{score(m.quality)}</td>
                <td className="px-4 py-3 text-right font-mono text-xs text-ink">{m.raw.medianTtftMs === null ? DASH : formatDuration(m.raw.medianTtftMs)}</td>
                <td className="px-4 py-3 text-right font-mono text-xs text-ink">{tokensPerSecond(m.raw.medianTokensPerS)}</td>
                {hideCosts ? null : <td className="px-4 py-3 text-right font-mono text-xs text-ink">{costPerAnswer(m.raw.meanCostUsd)}</td>}
                <td className="px-4 py-3 text-right font-mono text-xs text-ink">{reliabilityPercent(m.reliability)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PrintedDefinitions hideCosts={hideCosts} />
    </Card>
  );
}
