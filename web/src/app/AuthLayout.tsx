import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FanoutFallback } from '../three/FanoutFallback';
import { fanoutScene } from '../three/fanout-scene';
import { ThreeStage } from '../three/ThreeStage';
import { ProviderTicker } from './ProviderTicker';

/**
 * Mise en page des pages publiques (connexion, invitation, réinitialisation) : une carte translucide centrée
 * verticalement, sur la scène « un prompt, huit réponses ». Grand écran : carte à gauche, scène sur toute la page,
 * titre en haut à droite et bandeau des fournisseurs en bas à droite. Petit écran : carte centrée, scène en fond atténuée.
 * Le bloc de présentation est posé en absolu juste au-dessus de la carte, qui reste donc le point d'équilibre de la page.
 */
export function AuthLayout({ title, intro, children }: { title: string; intro?: ReactNode; children?: ReactNode }) {
  return (
    <main className="relative min-h-screen overflow-hidden">
      <ThreeStage
        factory={fanoutScene}
        className="opacity-40 lg:opacity-100"
        fallback={<FanoutFallback className="h-full w-full lg:translate-x-[8%]" />}
      />
      <div className="relative z-10 flex min-h-screen items-center justify-center px-4 py-44 lg:justify-start lg:pr-4 lg:pl-[6%]">
        <div className="relative w-full max-w-[26rem]">
          <div className="absolute inset-x-0 bottom-[calc(100%+22px)]">
            <Link to="/connexion" className="mb-3.5 flex items-center gap-3 text-white no-underline" aria-label="Eksplodo, connexion">
              <img src="/logo-icon-white.png" alt="" className="logo-glow block h-10 w-auto" />
              <span className="font-mono text-[21px] leading-tight font-semibold">
                Eksplodo
                <small className="block font-mono text-[10.5px] font-semibold tracking-[0.08em] text-mute">COMPARATEUR IA</small>
              </span>
            </Link>
            <p className="m-0 max-w-[380px] text-[14.5px] leading-[1.55] text-[#b9d4e1]">
              Le banc d'essai des IA : faites passer <strong className="font-semibold text-white">les mêmes tests</strong> à plusieurs
              modèles, puis comparez leur <strong className="font-semibold text-white">qualité</strong>, leur{' '}
              <strong className="font-semibold text-white">vitesse</strong>, leur <strong className="font-semibold text-white">coût</strong>{' '}
              et leur <strong className="font-semibold text-white">fiabilité</strong>, pour choisir le bon modèle pour chaque usage.
            </p>
          </div>
          <div className="card-surface p-7">
            <h1 className="m-0 font-display text-2xl font-extrabold tracking-[-0.01em] text-white">{title}</h1>
            {intro ? <p className="mt-2 mb-0 text-sm text-mute">{intro}</p> : null}
            {children ? <div className="mt-5">{children}</div> : null}
          </div>
        </div>
      </div>
      <p className="pointer-events-none absolute top-6 right-[4%] z-10 m-0 hidden text-right font-display text-[30px] leading-tight font-extrabold tracking-[-0.01em] text-white lg:block">
        Testé · chronométré · noté
      </p>
      <ProviderTicker />
    </main>
  );
}
