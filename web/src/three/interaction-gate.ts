/**
 * Active l'interaction tant qu'une media query correspond (ex. `(min-width: 1024px)`), et la suit en direct :
 * `attach` une seule fois quand elle correspond, `detach` quand elle cesse, `attach` de nouveau à son retour.
 * `dispose()` retire l'écouteur de la media query (il n'appelle pas `detach` : l'appelant nettoie lui-même).
 */
export function createInteractionGate(
  mql: Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>,
  hooks: { attach(): void; detach(): void },
): { dispose(): void } {
  let attached = false;
  let disposed = false;
  const apply = (matches: boolean) => {
    if (disposed || matches === attached) return;
    attached = matches;
    if (matches) hooks.attach();
    else hooks.detach();
  };
  const onChange = (e: { matches: boolean }) => apply(e.matches);
  mql.addEventListener('change', onChange);
  apply(mql.matches);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      mql.removeEventListener('change', onChange);
    },
  };
}
