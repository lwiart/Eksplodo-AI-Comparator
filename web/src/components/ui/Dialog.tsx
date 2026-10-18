import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

type DialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  children: ReactNode;
  /** `wide` pour les assistants à plusieurs colonnes. */
  size?: 'md' | 'wide';
};

/** Boîte de dialogue modale (Radix : focus piégé, Échap, annonce vocale du titre), avec une croix de fermeture en haut à droite. */
export function Dialog({ open, onOpenChange, title, description, children, size = 'md' }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-night-0/70 backdrop-blur-sm" />
        <RadixDialog.Content {...(description ? {} : { 'aria-describedby': undefined })} className={`card-surface fixed top-1/2 left-1/2 z-50 ${size === 'wide' ? 'w-[min(94vw,52rem)]' : 'w-[min(92vw,30rem)]'} -translate-x-1/2 -translate-y-1/2 p-6 shadow-2xl`}>
          <RadixDialog.Close
            aria-label="Fermer la fenêtre"
            className="absolute top-4 right-4 grid h-8 w-8 cursor-pointer place-items-center rounded-full border border-transparent bg-transparent text-xl leading-none text-mute hover:border-line-strong hover:text-white focus-visible:border-line-strong focus-visible:text-white focus-visible:outline-none"
          >
            <span aria-hidden="true">×</span>
          </RadixDialog.Close>
          <RadixDialog.Title className="m-0 pr-10 font-display text-lg font-bold text-white">{title}</RadixDialog.Title>
          {/* Sans description, aucune description : répéter le titre l'annoncerait deux fois. */}
          {description ? <RadixDialog.Description className="mt-1.5 mb-0 text-sm text-mute">{description}</RadixDialog.Description> : null}
          <div className="mt-4">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
