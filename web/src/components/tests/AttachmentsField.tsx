import { useRef, useState, type DragEvent } from 'react';
import { messageForError, messageFor } from '../../api/messages';
import { attachmentDownloadUrl, attachmentViewUrl, deleteAttachment, uploadAttachment, type PublicAttachment } from '../../api/tests';
import { formatSize } from '../../lib/format';
import { AttachmentThumb } from '../ui/AttachmentGallery';
import { Button } from '../ui/Button';
import { Lightbox, type LightboxItem } from '../ui/Lightbox';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/webp,application/pdf';

type Upload = { key: number; name: string; progress: number; error: string | null };

type Props = {
  testId: string;
  attachments: PublicAttachment[];
  onAdded(attachment: PublicAttachment): void;
  onRemoved(id: string): void;
};

/** Pièces jointes d'un test enregistré : dépôt par glisser-déposer ou sélection, progression, retrait. */
export function AttachmentsField({ testId, attachments, onAdded, onRemoved }: Props) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const nextKey = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  const patch = (key: number, change: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...change } : u)));
  const drop = (key: number) => setUploads((list) => list.filter((u) => u.key !== key));

  async function send(files: File[]) {
    setRemoveError(null);
    setUploads((list) => list.filter((u) => u.error === null)); // les refus précédents ont été lus
    for (const file of files) {
      const key = nextKey.current++;
      if (file.size > MAX_BYTES) {
        setUploads((list) => [...list, { key, name: file.name, progress: 0, error: messageFor('file_too_large') }]);
        continue;
      }
      setUploads((list) => [...list, { key, name: file.name, progress: 0, error: null }]);
      try {
        const added = await uploadAttachment(testId, file, (p) => patch(key, { progress: p }));
        onAdded(added);
        drop(key);
      } catch (err) {
        patch(key, { error: messageForError(err) });
      }
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void send([...e.dataTransfer.files]);
  }

  async function remove(a: PublicAttachment) {
    setRemoveError(null);
    try {
      await deleteAttachment(testId, a.id);
      onRemoved(a.id);
    } catch (err) {
      setRemoveError(messageForError(err));
    }
  }

  const items: LightboxItem[] = attachments.map((a) => ({
    name: a.originalName,
    mime: a.mime,
    pages: a.pages,
    viewUrl: attachmentViewUrl(testId, a.id),
    downloadUrl: attachmentDownloadUrl(testId, a.id),
  }));

  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-[13px] font-medium text-ink">Pièces jointes</span>
      <section
        aria-label="Zone de dépôt des pièces jointes"
        onDragOver={(e) => e.preventDefault()}
        onDragEnter={() => setDragging(true)}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-wrap items-center gap-3 rounded-[14px] border-[1.5px] border-dashed p-3.5 transition-colors ${
          dragging ? 'border-orange bg-orange/10' : 'border-line-strong'
        }`}
      >
        <span className="text-[13px] text-mute">Glissez une image ou un PDF ici (10 Mo au plus, 10 fichiers au plus).</span>
        <Button variant="secondary" className="ml-auto" onClick={() => input.current?.click()}>
          Choisir un fichier
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          aria-label="Choisir un fichier"
          onChange={(e) => {
            void send([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </section>

      {attachments.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {attachments.map((a, i) => (
            <li key={a.id} className="flex items-center gap-2 rounded-xl border border-line bg-night-0/40 px-3 py-2 text-[13px]">
              <AttachmentThumb item={items[i]!} size="sm" onOpen={() => setViewing(i)} />
              <a
                href={attachmentDownloadUrl(testId, a.id)}
                download={a.originalName}
                className="min-w-0 flex-1 truncate text-sky no-underline hover:underline"
              >
                {a.originalName}
                <span className="ml-2 font-mono text-[11px] text-mute">
                  {formatSize(a.size)}
                  {a.pages !== null ? ` · ${a.pages} ${a.pages > 1 ? 'pages' : 'page'}` : ''}
                </span>
              </a>
              <Button variant="ghost" aria-label={`Retirer ${a.originalName}`} onClick={() => void remove(a)}>
                Retirer
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <Lightbox items={items} index={viewing} onIndexChange={setViewing} />

      {uploads.map((u) =>
        u.error === null ? (
          <div key={u.key} className="flex flex-col gap-1">
            <span className="text-xs text-mute">{u.name}</span>
            <div
              role="progressbar"
              aria-label={`Envoi de ${u.name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(u.progress * 100)}
              className="h-1.5 overflow-hidden rounded-full bg-night-2"
            >
              <div className="h-full rounded-full bg-gradient-to-r from-orange to-orange-soft transition-[width]" style={{ width: `${u.progress * 100}%` }} />
            </div>
          </div>
        ) : (
          <p key={u.key} role="alert" className="m-0 text-xs text-bad">
            {u.name} : {u.error}
          </p>
        ),
      )}
      {removeError ? (
        <p role="alert" className="m-0 text-xs text-bad">
          {removeError}
        </p>
      ) : null}
    </div>
  );
}
