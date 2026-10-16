export type AnimationState = {
  reducedMotion: boolean;
  userPreference: boolean;
  pageVisible: boolean;
  inViewport: boolean;
};

/** La boucle d'animation ne tourne que si rien ne s'y oppose : mouvement réduit, réglage du compte, onglet masqué, scène hors écran. */
export function shouldAnimate(s: AnimationState): boolean {
  return !s.reducedMotion && s.userPreference && s.pageVisible && s.inViewport;
}

/** WebGL disponible ? Sans effet de bord ni exception (jsdom, navigateurs sans accélération). */
export function hasWebGL(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.WebGLRenderingContext === 'undefined') return false;
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Rapport de pixels du rendu : plafonné à 2 (coût GPU), 1 si la valeur est absente ou invalide. */
export function cappedPixelRatio(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1;
  return Math.min(devicePixelRatio, 2);
}
