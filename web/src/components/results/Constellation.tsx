import { useMemo } from 'react';
import type { RankingModel } from '../../api/results';
import { ConstellationFallback } from '../../three/ConstellationFallback';
import { constellationScene, type ConstellationData } from '../../three/constellation-scene';
import { ThreeStage } from '../../three/ThreeStage';
import { Card } from '../ui/Card';

/** Constellation des modèles : taille = qualité, orbite = débit, survol pour zoomer (grand écran). Légende en texte, la scène étant décorative. */
export function Constellation({ models }: { models: RankingModel[] }) {
  const data = useMemo<ConstellationData>(
    () => ({
      models: models.map((m) => ({
        id: m.modelId,
        color: m.color,
        quality: m.quality,
        tokensPerS: m.raw.medianTokensPerS,
      })),
    }),
    [models],
  );
  return (
    <Card className="relative h-[360px] overflow-hidden p-0">
      <ThreeStage factory={constellationScene} fallback={<ConstellationFallback data={data} />} data={data} />
      <h2 className="absolute top-3.5 left-4 m-0 font-display text-sm font-bold text-white">Constellation des modèles</h2>
      <ul aria-label="Légende de la constellation" className="absolute bottom-3.5 left-4 m-0 flex max-w-[80%] list-none flex-wrap gap-1.5 p-0">
        {models.map((m) => (
          <li
            key={m.modelId}
            className="flex items-center gap-1.5 rounded-full border border-line bg-night-0/60 px-2 py-0.5 font-mono text-[11px] font-medium text-white"
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor: m.quality === null ? '#7F8C95' : m.color,
              }}
            />
            {m.name}
          </li>
        ))}
      </ul>
      <p className="absolute right-3.5 bottom-3.5 m-0 hidden font-mono text-[10px] font-medium text-mute md:block">
        TAILLE = QUALITÉ · ORBITE = DÉBIT · SURVOLER POUR ZOOMER
      </p>
    </Card>
  );
}
