import { FIRST_ORBIT, astreColor, astreRadius, orbitRadius, type ConstellationData } from './constellation-scene';

const PEACH = '#FFB48A';
const PAD = 0.9;

/** Repli statique de la constellation (sans WebGL) : vue de dessus, un astre par modèle sur son orbite. */
export function ConstellationFallback({ data, className = '' }: { data: ConstellationData; className?: string }) {
  const count = data.models.length;
  const outer = (count > 0 ? orbitRadius(count - 1, count) : FIRST_ORBIT) + PAD;
  return (
    <svg
      data-testid="constellation-fallback"
      viewBox={`${-outer} ${-outer} ${2 * outer} ${2 * outer}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      className={`absolute inset-0 h-full w-full ${className}`}
    >
      {data.models.map((m, i) => {
        const r = orbitRadius(i, count);
        const angle = -Math.PI / 2 + i * 1.1; // même déphasage que la scène 3D
        const color = astreColor(m.color, m.quality);
        return (
          <g key={m.id} data-testid="constellation-astre">
            <circle r={r} fill="none" stroke="#3FA2E0" strokeOpacity="0.16" strokeWidth="0.03" />
            <circle cx={Math.cos(angle) * r} cy={Math.sin(angle) * r} r={astreRadius(m.quality)} fill={color} />
          </g>
        );
      })}
      <circle r="0.42" fill={PEACH} />
    </svg>
  );
}
