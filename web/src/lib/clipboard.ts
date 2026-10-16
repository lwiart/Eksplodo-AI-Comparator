import { useEffect, useRef, useState } from 'react';

const COPIED_MS = 2000;

/**
 * Copie un texte dans le presse-papiers. L'écriture est lancée immédiatement (de façon synchrone), ce qui permet
 * de l'appeler dans un gestionnaire de clic juste avant `window.open`. Vaut `false` si le presse-papiers est absent
 * (contexte non sécurisé) ou refusé.
 */
export function copyText(text: string): Promise<boolean> {
  try {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/** Copie avec confirmation : `copied` reste vrai pendant 2 s après une copie réussie. */
export function useCopy(): { copied: boolean; copy: (text: string) => Promise<boolean> } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function copy(text: string): Promise<boolean> {
    const done = copyText(text);
    void done.then((ok) => {
      if (!ok) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    });
    return done;
  }
  return { copied, copy };
}
