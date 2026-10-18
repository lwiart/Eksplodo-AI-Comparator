import type { ReactNode } from 'react';
import { InfoTip } from './InfoTip';

/**
 * Bouton secondaire qui porte son aide « ? » à l'intérieur de sa pastille : une seule forme visible, deux commandes
 * distinctes (l'action et l'aide), un bouton ne pouvant pas en contenir un autre.
 */
export function HelpButton({
  children,
  help,
  helpLabel,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  /** Texte de la bulle d'aide. */
  help: ReactNode;
  /** Nom de l'aide (« Aide : … ») ; le libellé du bouton par défaut. */
  helpLabel: string;
  onClick(): void;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex items-center rounded-full border border-line-strong bg-night-2/70 hover:bg-night-2">
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="cursor-pointer rounded-l-full border-0 bg-transparent py-2 pr-1.5 pl-4 font-sans text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {children}
      </button>
      <span className="pr-2.5">
        <InfoTip label={helpLabel} width="w-80">
          {help}
        </InfoTip>
      </span>
    </span>
  );
}
