import { useState } from 'react';
import { isPdf, Lightbox, type LightboxItem } from './Lightbox';

type ThumbProps = { item: LightboxItem; onOpen(): void; size?: 'sm' | 'md' };

/** Vignette cliquable d'une pièce jointe : l'image elle-même, ou une tuile « PDF » avec le nombre de pages. */
export function AttachmentThumb({ item, onOpen, size = 'md' }: ThumbProps) {
  const box = size === 'sm' ? 'h-10 w-10' : 'h-24 w-24';
  return (
    <button
      type="button"
      aria-label={`Afficher ${item.name}`}
      onClick={onOpen}
      className={`${box} shrink-0 cursor-pointer overflow-hidden rounded-lg border border-line bg-night-0/60 p-0 transition-colors hover:border-orange/70`}
    >
      {isPdf(item.mime) ? (
        <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 font-mono text-mute">
          <span className={`font-bold text-peach ${size === 'sm' ? 'text-[10px]' : 'text-sm'}`}>PDF</span>
          {size === 'md' && item.pages ? (
            <span className="text-[10px]">
              {item.pages} {item.pages > 1 ? 'pages' : 'page'}
            </span>
          ) : null}
        </span>
      ) : (
        <img src={item.viewUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
      )}
    </button>
  );
}

/** Bande de vignettes : chacune ouvre la visionneuse, le nom en dessous reste un lien de téléchargement. */
export function AttachmentGallery({ items, label = 'Pièces jointes' }: { items: LightboxItem[]; label?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  if (items.length === 0) return null;
  return (
    <>
      <ul aria-label={label} className="m-0 flex list-none flex-wrap gap-3 p-0">
        {items.map((item, i) => (
          <li key={item.downloadUrl} className="flex w-24 flex-col gap-1">
            <AttachmentThumb item={item} onOpen={() => setOpen(i)} />
            <a href={item.downloadUrl} download={item.name} title={`Télécharger ${item.name}`} className="truncate text-[11px] text-sky no-underline hover:underline">
              {item.name}
            </a>
          </li>
        ))}
      </ul>
      <Lightbox items={items} index={open} onIndexChange={setOpen} />
    </>
  );
}
