import { useEffect, useState, type RefObject } from 'react';
import { getAnimationsPreference } from '../app/preferences';
import { shouldAnimate } from './animation-policy';

export type SceneFactory = (ctx: {
  THREE: typeof import('three');
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  isMobile: boolean;
}) => { render(dtSeconds: number): void; resize(width: number, height: number): void; dispose(): void };

export type SceneStatus = 'loading' | 'running' | 'paused' | 'fallback';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const MAX_DT = 0.1; // un onglet resté en arrière-plan ne doit pas provoquer un saut à son retour

/**
 * Charge Three.js à la demande (fragment séparé), crée la scène et pilote sa boucle d'animation.
 * Le canevas est dimensionné d'après son parent. Hors animation, une image fixe reste affichée.
 */
export function useThreeScene(factory: SceneFactory, canvasRef: RefObject<HTMLCanvasElement | null>): { status: SceneStatus } {
  const [status, setStatus] = useState<SceneStatus>('loading');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let scene: ReturnType<SceneFactory> | null = null;
    let frame = 0;
    let last = 0;
    const cleanups: Array<() => void> = [];

    const reducedQuery = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION) : null;
    const state = {
      reducedMotion: reducedQuery?.matches ?? false,
      userPreference: getAnimationsPreference(),
      pageVisible: document.visibilityState !== 'hidden',
      inViewport: true,
    };

    const size = () => {
      const parent = canvas.parentElement ?? canvas;
      return { width: Math.max(1, parent.clientWidth), height: Math.max(1, parent.clientHeight) };
    };

    const tick = (now: number) => {
      if (!scene) return;
      const dt = last === 0 ? 0 : Math.min((now - last) / 1000, MAX_DT);
      last = now;
      scene.render(dt);
      frame = requestAnimationFrame(tick);
    };

    const sync = () => {
      if (!scene) return;
      if (shouldAnimate(state)) {
        if (frame === 0) {
          last = 0;
          frame = requestAnimationFrame(tick);
        }
        setStatus('running');
      } else {
        if (frame !== 0) cancelAnimationFrame(frame);
        frame = 0;
        scene.render(0); // image fixe
        setStatus('paused');
      }
    };

    void import('three')
      .then((THREE) => {
        if (cancelled) return;
        const { width, height } = size();
        const isMobile = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches;
        scene = factory({ THREE, canvas, width, height, isMobile });

        const onVisibility = () => {
          state.pageVisible = document.visibilityState !== 'hidden';
          sync();
        };
        document.addEventListener('visibilitychange', onVisibility);
        cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

        if (reducedQuery) {
          const onReduced = (e: MediaQueryListEvent) => {
            state.reducedMotion = e.matches;
            sync();
          };
          reducedQuery.addEventListener('change', onReduced);
          cleanups.push(() => reducedQuery.removeEventListener('change', onReduced));
        }

        // Le réglage « Animations » du compte est reflété sur <html data-animations> (voir AppShell).
        if (typeof MutationObserver !== 'undefined') {
          const mo = new MutationObserver(() => {
            state.userPreference = getAnimationsPreference();
            sync();
          });
          mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-animations'] });
          cleanups.push(() => mo.disconnect());
        }

        if (typeof IntersectionObserver !== 'undefined') {
          const io = new IntersectionObserver((entries) => {
            const entry = entries[entries.length - 1];
            if (entry) {
              state.inViewport = entry.isIntersecting;
              sync();
            }
          });
          io.observe(canvas);
          cleanups.push(() => io.disconnect());
        }

        if (typeof ResizeObserver !== 'undefined') {
          const ro = new ResizeObserver(() => {
            const s = size();
            scene?.resize(s.width, s.height);
            if (frame === 0) scene?.render(0);
          });
          ro.observe(canvas.parentElement ?? canvas);
          cleanups.push(() => ro.disconnect());
        }

        sync();
      })
      .catch(() => {
        if (!cancelled) setStatus('fallback'); // chargement du fragment ou contexte WebGL impossible
      });

    return () => {
      cancelled = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      cleanups.forEach((fn) => fn());
      scene?.dispose();
      scene = null;
    };
  }, [factory, canvasRef]);

  return { status };
}
