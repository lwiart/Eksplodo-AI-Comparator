import { useRef, useState, type ReactNode } from 'react';
import { hasWebGL } from './animation-policy';
import { useThreeScene, type SceneFactory } from './useThreeScene';

function StageCanvas({ factory, fallback, data }: { factory: SceneFactory; fallback: ReactNode; data?: unknown }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { status } = useThreeScene(factory, canvasRef, data);
  if (status === 'fallback') return <>{fallback}</>;
  return <canvas ref={canvasRef} className="pointer-events-auto absolute inset-0 block h-full w-full" />;
}

/** Scène Three.js plein cadre ; repli statique sans WebGL. Décorative, donc masquée aux lecteurs d'écran. */
export function ThreeStage({
  factory,
  fallback,
  data,
  className = '',
}: {
  factory: SceneFactory;
  fallback: ReactNode;
  data?: unknown;
  className?: string;
}) {
  const [webgl] = useState(hasWebGL);
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      {webgl ? <StageCanvas factory={factory} fallback={fallback} data={data} /> : fallback}
    </div>
  );
}
