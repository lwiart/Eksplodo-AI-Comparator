import { useId } from 'react';
import type { RankedRow } from '../../lib/ranking';
import { formatDuration } from '../tests/QuickTryPanel';
import { Card } from '../ui/Card';
import { InfoTip } from '../ui/InfoTip';
import { DEFINITION_LABELS, DEFINITIONS, type DefinitionKey } from './definitions';
import { DASH, costPerAnswer, reliabilityPercent, score, tokensPerSecond } from './format';

const TH = 'px-4 py-3 font-medium';

/**
 * En-tête de colonne avec une icône d'aide. Le nom accessible reste le seul intitulé (`aria-label`) :
 * la bulle a son propre bouton et n'est pas relue à chaque cellule.
 */
function HelpHeader({ title, help, helpLabel, className, align = 'left' }: { title: string; help: string; helpLabel: string; className: string; align?: 'left' | 'right' }) {
  return (
    <th scope="col" aria-label={title} className={className}>
      <span className="inline-flex items-center gap-1.5">
        {title}
        <InfoTip label={helpLabel} align={align}>
          {help}
        </InfoTip>
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
export function RankingTable({ rows, judgeName, hideCosts = false }: { rows: RankedRow[]; judgeName?: string | null; hideCosts?: boolean }) {
  const headingId = useId();
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
        <table aria-labelledby={headingId} className="ranking-table w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-mute">
              <th scope="col" className={`${TH} ranking-col-rank`}>Rang</th>
              <th scope="col" className={`${TH} ranking-col-model`}>Modèle</th>
              <HelpHeader title="Score global" helpLabel={DEFINITION_LABELS.global} help={DEFINITIONS.global} className={TH} />
              <HelpHeader title="Qualité" helpLabel={DEFINITION_LABELS.quality} help={DEFINITIONS.quality} className={`${TH} text-right`} align="right" />
              <HelpHeader title="Premier token médian" helpLabel="Premier token (vitesse)" help={DEFINITIONS.speed} className={`${TH} text-right`} align="right" />
              <HelpHeader title="Débit médian" helpLabel="Débit (vitesse)" help={DEFINITIONS.speed} className={`${TH} text-right`} align="right" />
              {hideCosts ? null : <HelpHeader title="Coût moyen" helpLabel={DEFINITION_LABELS.cost} help={DEFINITIONS.cost} className={`${TH} text-right`} align="right" />}
              <HelpHeader title="Fiabilité" helpLabel={DEFINITION_LABELS.reliability} help={DEFINITIONS.reliability} className={`${TH} text-right`} align="right" />
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
