import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BurstFallback } from '../three/BurstFallback';
import { burstScene } from '../three/burst-scene';
import { ThreeStage } from '../three/ThreeStage';

/**
 * Mise en page des pages publiques (connexion, invitation, réinitialisation) : une carte translucide posée sur la
 * gerbe Eksplodo. Grand écran : carte à gauche, gerbe à droite. Mobile : carte centrée devant la gerbe.
 */
export function AuthLayout({ title, intro, children }: { title: string; intro?: ReactNode; children?: ReactNode }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10 lg:justify-start lg:px-[8vw]">
      <ThreeStage factory={burstScene} fallback={<BurstFallback className="h-full w-full lg:translate-x-[22%]" />} />
      <div className="relative z-10 w-full max-w-[26rem]">
        <Link to="/connexion" className="mb-7 flex items-center gap-2.5 text-white no-underline" aria-label="Eksplodo, connexion">
          <img src="/logo-icon-white.png" alt="" className="logo-glow block h-[42px] w-auto" />
          <span className="font-mono text-xl leading-tight font-semibold">
            Eksplodo
            <small className="block font-mono text-[10px] font-medium tracking-[0.06em] text-mute">COMPARATEUR IA</small>
          </span>
        </Link>
        <div className="card-surface p-7">
          <h1 className="m-0 font-display text-2xl font-extrabold tracking-[-0.01em] text-white">{title}</h1>
          {intro ? <p className="mt-2 mb-0 text-sm text-mute">{intro}</p> : null}
          {children ? <div className="mt-5">{children}</div> : null}
        </div>
      </div>
    </main>
  );
}
