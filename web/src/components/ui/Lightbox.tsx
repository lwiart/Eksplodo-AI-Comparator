import * as RadixDialog from '@radix-ui/react-dialog';
import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';

/** Pièce jointe affichable : `viewUrl` sert le fichier en `inline`, `downloadUrl` en pièce jointe. */
export type LightboxItem = { name: string; mime: string; viewUrl: string; downloadUrl: string; pages?: number | null };

type LightboxProps = {
  items: LightboxItem[];
  /** Pièce affichée ; `null` ferme la visionneuse. */
  index: number | null;
  onIndexChange(index: number | null): void;
};

export const isPdf = (mime: string) => mime === 'application/pdf';

const NAV =
  'grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-full border border-line-strong bg-night-2/80 text-xl text-white hover:bg-night-2';

/**
 * Visionneuse plein écran des pièces jointes (images et PDF), sur les primitives Radix de `Dialog` :
 * focus piégé, Échap, focus rendu à l'élément déclencheur. Flèches gauche et droite pour passer d'une pièce à l'autre,
 * clic sur le fond pour fermer.
 */
export function Lightbox({ items, index, onIndexChange }: LightboxProps) {
  const item = index === null ? undefined : items[index];
  const open = item !== undefined;
  // Sans `Dialog.Trigger`, Radix ne sait pas où rendre le focus : on retient l'élément actif au rendu qui ouvre,
  // avant que le focus n'entre dans la visionneuse (les effets montés deux fois en StrictMode le verraient déjà déplacé).
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
  useEffect(() => {
    wasOpen.current = open;
  }, [open]);
  const many = items.length > 1;
  const go = (step: number) => {
    if (index === null || !many) return;
    onIndexChange((index + step + items.length) % items.length);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(1);
    }
  };
  // Le fond occupe tout l'écran à l'intérieur du contenu : un clic qui n'atteint ni la pièce ni un bouton ferme.
  const closeOnBackdrop = (e: MouseEvent) => {
    if (e.target === e.currentTarget) onIndexChange(null);
  };
  // L'image occupe toute la zone (object-contain) : un clic dans les bandes vides autour de l'image vaut un clic sur le fond.
  const closeOutsideImage = (e: MouseEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (!img.naturalWidth || !img.naturalHeight) return;
    const box = img.getBoundingClientRect();
    const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    const left = box.left + (box.width - w) / 2;
    const top = box.top + (box.height - h) / 2;
    if (e.clientX < left || e.clientX > left + w || e.clientY < top || e.clientY > top + h) onIndexChange(null);
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={(open) => !open && onIndexChange(null)}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-night-0/90 backdrop-blur-sm" />
        {item ? (
          <RadixDialog.Content
            aria-describedby={undefined}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              returnFocus.current?.focus();
            }}
            onKeyDown={onKeyDown}
            className="fixed inset-0 z-50 flex flex-col gap-3 p-3 sm:p-5"
          >
            <header className="flex items-center gap-3">
              <RadixDialog.Title className="m-0 min-w-0 flex-1 truncate font-display text-base font-bold text-white" title={item.name}>
                {item.name}
              </RadixDialog.Title>
              {many ? (
                <span className="font-mono text-xs text-mute">
                  {index! + 1} / {items.length}
                </span>
              ) : null}
              <a
                href={item.downloadUrl}
                download={item.name}
                className="inline-flex items-center justify-center rounded-full border border-line-strong bg-night-2/70 px-4 py-2 text-[13px] font-semibold text-white no-underline hover:bg-night-2"
              >
                Télécharger
              </a>
              <RadixDialog.Close aria-label="Fermer" className={NAV}>
                <span aria-hidden="true">×</span>
              </RadixDialog.Close>
            </header>

            <div className="flex min-h-0 flex-1 items-center gap-2 sm:gap-4" onClick={closeOnBackdrop}>
              {many ? (
                <button type="button" aria-label="Pièce précédente" className={NAV} onClick={() => go(-1)}>
                  <span aria-hidden="true">‹</span>
                </button>
              ) : null}
              <div className="flex h-full min-w-0 flex-1 items-center justify-center" onClick={closeOnBackdrop}>
                {isPdf(item.mime) ? (
                  <iframe key={item.viewUrl} src={item.viewUrl} title={item.name} className="h-full w-full rounded-xl border border-line bg-white" />
                ) : (
                  <img key={item.viewUrl} src={item.viewUrl} alt={item.name} onClick={closeOutsideImage} className="h-full w-full object-contain drop-shadow-2xl" />
                )}
              </div>
              {many ? (
                <button type="button" aria-label="Pièce suivante" className={NAV} onClick={() => go(1)}>
                  <span aria-hidden="true">›</span>
                </button>
              ) : null}
            </div>
          </RadixDialog.Content>
        ) : null}
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
