import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RankingModel } from '../../api/results';
import { ConstellationFallback } from '../../three/ConstellationFallback';
import {
  CONSTELLATION_HOVER_EVENT,
  UNRATED_COLOR,
  constellationScene,
  placeLabel,
  type ConstellationData,
  type ConstellationHover,
} from '../../three/constellation-scene';
import { ThreeStage } from '../../three/ThreeStage';
import { Card } from '../ui/Card';
import { InfoTip } from '../ui/InfoTip';
import { score, tokensPerSecond } from './format';

/** Mesures de l'étiquette de survol : « Qualité 87/100 · 54,2 tokens/s », ou « Pas encore noté ». */
export function hoverDetails(m: RankingModel): string {
  if (m.quality === null) return 'Pas encore noté';
  const parts = [`Qualité ${score(m.quality)}/100`];
  if (m.raw.medianTokensPerS !== null) parts.push(tokensPerSecond(m.raw.medianTokensPerS));
  return parts.join(' · ');
}

/**
 * Constellation des modèles : un astre par modèle, de sa couleur (gris et plus petit tant qu'il n'est pas noté).
 * Taille = qualité (note sur 100) ; distance au centre = débit médian en tokens par seconde : le plus rapide sur l'orbite
 * la plus proche du centre, puis par débit décroissant, les modèles sans débit à l'extérieur (voir `orbitRanks`). La
 * vitesse de rotation suit aussi le débit (les astres proches tournent plus vite). Une icône « ? » l'explique.
 * Sur grand écran, survoler un astre affiche son nom, sa qualité et son débit dans une étiquette qui le suit : la scène
 * émet `CONSTELLATION_HOVER_EVENT` sur son canevas, l'événement remonte jusqu'au cadre écouté ici.
 * Sur mobile ou sans WebGL, pas de survol : la légende en texte suffit (la scène reste décorative).
 */
export function Constellation({ models, className = '' }: { models: RankingModel[]; className?: string }) {
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

  const stageRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<ConstellationHover | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Place l'étiquette près de l'astre, sans rendu React : la position change à chaque image tant que l'astre tourne.
  const placeRef = useRef(() => {
    const stage = stageRef.current;
    const label = labelRef.current;
    const hover = hoverRef.current;
    if (!stage || !label || !hover) return;
    const { left, top } = placeLabel(hover, { w: label.offsetWidth, h: label.offsetHeight }, { w: stage.clientWidth, h: stage.clientHeight });
    label.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  });

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onHover = (e: Event) => {
      const hover = (e as CustomEvent<ConstellationHover | null>).detail ?? null;
      hoverRef.current = hover;
      setHoveredId(hover?.id ?? null);
      placeRef.current();
    };
    stage.addEventListener(CONSTELLATION_HOVER_EVENT, onHover);
    return () => stage.removeEventListener(CONSTELLATION_HOVER_EVENT, onHover);
  }, []);

  const hovered = hoveredId === null ? undefined : models.find((m) => m.modelId === hoveredId);
  // Nouvelle étiquette (autre astre) : sa taille change, on la replace une fois rendue.
  useLayoutEffect(() => placeRef.current(), [hovered]);

  return (
    <Card className={`relative h-full min-h-[360px] overflow-hidden p-0 ${className}`}>
      <div ref={stageRef} className="pointer-events-none absolute inset-0">
        <ThreeStage factory={constellationScene} fallback={<ConstellationFallback data={data} />} data={data} />
        {hovered && (
          <div
            ref={labelRef}
            data-testid="constellation-etiquette"
            aria-hidden="true"
            className="absolute top-0 left-0 z-20 flex items-center gap-1.5 rounded-lg border bg-night-1/90 px-2.5 py-1 font-mono text-[11px] whitespace-nowrap text-white shadow-2xl"
            style={{ borderColor: hovered.quality === null ? UNRATED_COLOR : hovered.color }}
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: hovered.quality === null ? UNRATED_COLOR : hovered.color }}
            />
            <span className="font-medium">{hovered.name}</span>
            <span className="text-mute">{hoverDetails(hovered)}</span>
          </div>
        )}
      </div>
      <div className="absolute top-3.5 left-4 z-30 flex items-center gap-2">
        <h2 className="m-0 font-display text-sm font-bold text-white">Constellation des modèles</h2>
        <InfoTip label="Constellation">
          Chaque astre est un modèle, de sa couleur. Sa taille suit la qualité (note sur 100) ; gris et plus petit, il n’est
          pas encore noté. Sa distance au centre suit le débit médian en tokens par seconde : le modèle le plus proche du
          centre a le plus haut débit, et il tourne aussi le plus vite. Les modèles sans débit mesuré sont sur les orbites
          extérieures.
        </InfoTip>
      </div>
      {/* Légende et consigne dans une même rangée : la consigne reste à droite, ou passe à la ligne, sans chevauchement. */}
      <div className="absolute inset-x-4 bottom-3.5 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <ul aria-label="Légende de la constellation" className="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0">
          {models.map((m) => (
            <li
              key={m.modelId}
              className="flex items-center gap-1.5 rounded-full border border-line bg-night-0/60 px-2 py-0.5 font-mono text-[11px] font-medium text-white"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{
                  backgroundColor: m.quality === null ? UNRATED_COLOR : m.color,
                }}
              />
              {m.name}
            </li>
          ))}
        </ul>
        <p className="m-0 ml-auto hidden min-w-0 text-right font-mono text-[10px] font-medium text-mute md:block">
          Taille = qualité · Plus près du centre = débit plus élevé
          {/* Le survol n'existe que sur grand écran (voir la scène). */}
          <span className="hidden lg:inline"> · Survolez un astre pour son nom</span>
        </p>
      </div>
    </Card>
  );
}
