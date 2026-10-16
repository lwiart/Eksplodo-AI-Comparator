import { useCopy } from '../../lib/clipboard';
import { Button } from './Button';

/** Lien à transmettre à la main (invitation, réinitialisation) : champ en lecture seule et bouton « Copier ». */
export function CopyLink({ url, label = 'Lien à transmettre' }: { url: string; label?: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink">{label}</span>
      <div className="flex gap-2">
        <input
          readOnly
          aria-label={label}
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-xl border border-line-strong bg-night-0/60 px-3 py-2 font-mono text-xs text-ink"
        />
        <Button variant="secondary" onClick={() => void copy(url)}>
          {copied ? 'Copié' : 'Copier'}
        </Button>
      </div>
      <span role="status" className="sr-only">
        {copied ? 'Lien copié dans le presse-papiers' : ''}
      </span>
    </div>
  );
}
