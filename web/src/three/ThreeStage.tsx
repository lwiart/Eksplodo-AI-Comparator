import { useRef, useState, type ReactNode } from 'react';
import { hasWebGL } from './animation-policy';
import { useThreeScene, type SceneFactory } from './useThreeScene';

function StageCanvas({ factory, fallback }: { factory: SceneFactory; fallback: ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { status } = useThreeScene(factory, canvasRef);
  if (status === 'fallback') return <>{fallback}</>;
  return <canvas ref={canvasRef} className="pointer-events-auto absolute inset-0 block h-full w-full" />;
}

/** Scène Three.js plein cadre ; repli statique sans WebGL. Décorative, donc masquée aux lecteurs d'écran. */
export function ThreeStage({ factory, fallback, className = '' }: { factory: SceneFactory; fallback: ReactNode; className?: string }) {
  const [webgl] = useState(hasWebGL);
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      {webgl ? <StageCanvas factory={factory} fallback={fallback} /> : fallback}
    </div>
  );
}
