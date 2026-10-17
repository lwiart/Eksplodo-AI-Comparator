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

let webglProbe: boolean | null = null;

/** Oublie le résultat mémorisé de la sonde (tests). */
export function resetWebGLProbe(): void {
  webglProbe = null;
}

/**
 * WebGL disponible ? Sans effet de bord ni exception (jsdom, navigateurs sans accélération).
 * Le résultat est mémorisé (un seul contexte de sonde par page) et le contexte est libéré aussitôt.
 */
export function hasWebGL(): boolean {
  if (webglProbe !== null) return webglProbe;
  try {
    if (typeof window === 'undefined' || typeof window.WebGLRenderingContext === 'undefined') return (webglProbe = false);
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | WebGL2RenderingContext | null;
    if (!gl) return (webglProbe = false);
    try {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // la libération est un confort : son échec ne change pas la disponibilité
    }
    return (webglProbe = true);
  } catch {
    return (webglProbe = false);
  }
}

/** Rapport de pixels du rendu : plafonné à 2 (coût GPU), 1 si la valeur est absente ou invalide. */
export function cappedPixelRatio(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1;
  return Math.min(devicePixelRatio, 2);
}
