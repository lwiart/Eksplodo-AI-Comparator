import { Link } from 'react-router-dom';
import type { Dashboard } from '../../api/dashboard';
import { plural, usd } from '../../lib/format';
import { Card } from '../ui/Card';

function Kpi({ label, value, valueTone = 'text-white', children }: { label: string; value: string; valueTone?: string; children?: React.ReactNode }) {
  return (
    <Card className="px-5 py-4">
      <p className="m-0 font-mono text-[11px] font-semibold tracking-[0.08em] text-mute uppercase">{label}</p>
      <p className={`m-0 mt-1.5 font-display text-[32px] leading-none font-extrabold ${valueTone}`}>{value}</p>
      <p className="m-0 mt-2 text-xs text-mute">{children}</p>
    </Card>
  );
}

/** Mois de la dépense en toutes lettres (« octobre »), à l'heure de Paris. */
const monthName = (now: Date) => now.toLocaleDateString('fr-FR', { month: 'long', timeZone: 'Europe/Paris' });

/** Chiffres clés : la dépense n'est transmise qu'à l'Admin, la carte n'existe donc que si elle est présente. */
export function KpiCards({ data, now = new Date() }: { data: Dashboard; now?: Date }) {
  const { toScore, spend } = data;
  return (
    <div className="mb-4 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
      <Kpi label="Séries lancées" value={String(data.runs.total)}>
        <span className="text-good">+{data.runs.thisMonth} ce mois-ci</span>
      </Kpi>
      <Kpi label="Modèles suivis" value={String(data.models.tracked)}>
        {plural(data.models.providers, 'fournisseur', 'fournisseurs')}
      </Kpi>
      {spend ? (
        <Kpi label={`Dépense API · ${monthName(now)}`} value={usd(spend.monthUsd)}>
          dont juge {usd(spend.judgeUsd)}
        </Kpi>
      ) : null}
      <Kpi label="Réponses à noter" value={String(toScore.questions)} valueTone={toScore.questions > 0 ? 'text-peach' : 'text-white'}>
        {toScore.questions > 0 ? (
          <Link to="/a-noter" className="text-peach underline-offset-2 hover:underline">
            {toScore.runName ?? 'Voir la liste'}
          </Link>
        ) : (
          'Rien en attente'
        )}
      </Kpi>
    </div>
  );
}
