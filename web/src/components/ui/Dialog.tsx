import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

type DialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  children: ReactNode;
};

/** Boîte de dialogue modale (Radix : focus piégé, Échap, annonce vocale du titre). */
export function Dialog({ open, onOpenChange, title, description, children }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-night-0/70 backdrop-blur-sm" />
        <RadixDialog.Content className="card-surface fixed top-1/2 left-1/2 z-50 w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 p-6 shadow-2xl">
          <RadixDialog.Title className="m-0 font-display text-lg font-bold text-white">{title}</RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className="mt-1.5 mb-0 text-sm text-mute">{description}</RadixDialog.Description>
          ) : (
            <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
          )}
          <div className="mt-4">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
