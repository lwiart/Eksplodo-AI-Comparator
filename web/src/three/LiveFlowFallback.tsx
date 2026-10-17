import { ARC_RX, ARC_RZ, nodePositions, type LiveFlowData } from './live-flow-scene';

const PEACH = '#FFB48A';
const PAD = 0.9;

/** Repli statique du « flux en direct » (sans WebGL) : le prompt, un nœud par modèle et le nombre d'appels en cours. */
export function LiveFlowFallback({ data, className = '' }: { data: LiveFlowData; className?: string }) {
  const positions = nodePositions(data.models.length);
  const running = new Map<string, number>();
  for (const r of data.running) running.set(r.modelId, (running.get(r.modelId) ?? 0) + 1);

  // Vue de dessus du plan x-z de la scène : x vers la droite, z (vers la caméra) vers le bas.
  return (
    <svg
      data-testid="live-flow-fallback"
      viewBox={`${-ARC_RX - PAD} ${-ARC_RZ - PAD} ${2 * (ARC_RX + PAD)} ${ARC_RZ + 2 * PAD}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      className={`absolute inset-0 h-full w-full ${className}`}
    >
      {data.models.map((m, i) => {
        const p = positions[i]!;
        const calls = running.get(m.id) ?? 0;
        return (
          <g key={m.id} data-testid="live-flow-node">
            <line x1="0" y1="0" x2={p.x} y2={p.z} stroke={m.color} strokeOpacity={calls > 0 ? 0.6 : 0.2} strokeWidth="0.03" strokeDasharray={calls > 0 ? '0.12 0.08' : undefined} />
            <circle cx={p.x} cy={p.z} r="0.28" fill={m.color} />
            {calls > 0 ? (
              <text x={p.x} y={p.z - 0.45} textAnchor="middle" fontFamily="'Noto Sans Mono', monospace" fontWeight="600" fontSize="0.26" fill="#fff">
                {calls}
              </text>
            ) : null}
          </g>
        );
      })}
      <circle r="0.5" fill="none" stroke={PEACH} strokeWidth="0.05" />
      <circle r="0.18" fill={PEACH} />
    </svg>
  );
}
