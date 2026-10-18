import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { messageForError } from '../../api/messages';
import { exportXlsxUrl, rankingKey, type Ranking } from '../../api/results';
import { RUNS_KEY, updateRun, type Weights } from '../../api/runs';
import { rankedRows, sameWeights } from '../../lib/ranking';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { CategoryHeatmap } from './CategoryHeatmap';
import { Constellation } from './Constellation';
import { Podium } from './Podium';
import { QualitySpeedChart, QualitySpeedHeading } from './QualitySpeedChart';
import { RankingTable } from './RankingTable';
import { WeightSliders } from './WeightSliders';

/** Vue résultats d'une série : podium et pondération, graphes, classement ; le classement se recalcule sans appel serveur. */
export default function ResultsView({ runId, ranking, isAdmin }: { runId: string; ranking: Ranking; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [weights, setWeights] = useState<Weights>(ranking.weights);
  const rows = useMemo(() => rankedRows(ranking.models, weights), [ranking.models, weights]);
  const rankedModels = useMemo(() => rows.map((r) => r.model), [rows]);
  const changed = !sameWeights(weights, ranking.weights);

  const save = useMutation({
    mutationFn: () => updateRun(runId, { weights }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: rankingKey(runId) }),
        queryClient.invalidateQueries({ queryKey: [...RUNS_KEY, runId], exact: true }),
      ]);
    },
  });

  return (
    <section aria-label="Résultats" className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Constellation models={ranking.models} />
        <Card className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="m-0 font-display text-base font-bold text-white">
              Podium <span className="ml-1 font-mono text-[11px] font-medium text-mute">score global pondéré</span>
            </h2>
            {/* Télécharge le classeur XLSX de la série. */}
            <a
              href={exportXlsxUrl(runId)}
              download
              className="inline-flex items-center justify-center rounded-full border border-line-strong bg-night-2/70 px-4 py-2 text-[13px] font-semibold text-white no-underline hover:bg-night-2"
            >
              Exporter
            </a>
          </div>
          {/* Le podium remplit la hauteur libre de la carte (alignée sur la constellation), sans descendre sous 220 px. */}
          <div className="min-h-[220px] flex-1">
            <Podium rows={rows} />
          </div>
          <div>
            <h3 className="m-0 mb-3 font-display text-sm font-bold text-white">
              Pondération <span className="ml-1 font-mono text-[11px] font-medium text-mute">recalcul instantané</span>
            </h3>
            <WeightSliders value={weights} onChange={setWeights} />
            {isAdmin ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button variant="secondary" disabled={!changed || save.isPending} onClick={() => save.mutate()}>
                  Enregistrer comme pondération par défaut
                </Button>
                {changed ? (
                  <Button variant="ghost" onClick={() => setWeights(ranking.weights)}>
                    Rétablir
                  </Button>
                ) : null}
                {save.isError ? (
                  <span role="alert" className="text-sm text-bad">
                    {messageForError(save.error)}
                  </span>
                ) : save.isSuccess && !changed ? (
                  <span role="status" className="text-sm text-good">
                    Pondération enregistrée.
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      {/* Nuage puis matrice, chacun sur toute la largeur : la matrice a besoin de place pour ses colonnes. */}
      <Card className="min-w-0">
        <QualitySpeedHeading />
        <QualitySpeedChart models={rankedModels} />
      </Card>
      <Card className="min-w-0">
        <h2 className="m-0 mb-2 font-display text-sm font-bold text-white">
          Qualité par catégorie de test <span className="ml-1 font-mono text-[11px] font-medium text-mute">note moyenne sur 100</span>
        </h2>
        <CategoryHeatmap models={rankedModels} categories={ranking.categories} />
      </Card>

      <RankingTable rows={rows} judgeName={ranking.judge?.modelName} />
    </section>
  );
}
