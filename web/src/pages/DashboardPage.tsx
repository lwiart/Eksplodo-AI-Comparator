import { useQuery } from '@tanstack/react-query';
import { NEW_MODELS_KEY, listNewModels } from '../api/catalog';
import { DASHBOARD_KEY, getDashboard } from '../api/dashboard';
import { messageForError } from '../api/messages';
import { useAuth } from '../auth/AuthProvider';
import { NewModelsCard } from '../components/catalog/NewModelsCard';
import { KpiCards } from '../components/dashboard/KpiCards';
import { QualityEvolutionChart } from '../components/dashboard/QualityEvolutionChart';
import { RecentRuns } from '../components/dashboard/RecentRuns';
import { plural } from '../lib/format';

/** Tableau de bord : chiffres clés, évolution de la qualité et dernières séries ; dépense et nouveautés pour l'Admin seulement. */
export function DashboardPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const firstName = user?.name.trim().split(/\s+/)[0] ?? '';
  const dashboard = useQuery({ queryKey: DASHBOARD_KEY, queryFn: getDashboard });
  // Même clé que la carte des nouveautés : une seule requête, aucun appel pour un Utilisateur.
  const fresh = useQuery({ queryKey: NEW_MODELS_KEY, queryFn: listNewModels, enabled: isAdmin });
  const newCount = fresh.data?.models.length ?? 0;

  return (
    <div className="mx-auto max-w-[1100px]">
      <h1 className="m-0 mb-5 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">
        Bonjour {firstName}
        {isAdmin && newCount > 0 ? (
          <>
            , <em className="text-orange-soft not-italic">{plural(newCount, 'nouveau modèle', 'nouveaux modèles')}</em> à tester
          </>
        ) : null}
      </h1>

      {dashboard.isError ? (
        <p role="alert" className="text-sm text-bad">
          {messageForError(dashboard.error)}
        </p>
      ) : dashboard.isPending ? (
        <p className="text-sm text-mute">Chargement du tableau de bord…</p>
      ) : (
        <>
          <KpiCards data={dashboard.data} />
          <div className={`mb-4 grid gap-4 ${isAdmin ? 'lg:grid-cols-[1.6fr_1fr]' : ''}`}>
            <QualityEvolutionChart suites={dashboard.data.evolutionSuites} />
            {isAdmin ? <NewModelsCard /> : null}
          </div>
          <RecentRuns runs={dashboard.data.recentRuns} />
        </>
      )}
    </div>
  );
}
