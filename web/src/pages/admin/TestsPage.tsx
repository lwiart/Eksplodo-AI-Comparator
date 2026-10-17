import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPreviousData } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { messageForError } from '../../api/messages';
import {
  TESTS_KEY,
  TESTS_META_KEY,
  deleteTest,
  listTests,
  restoreTest,
  testsMeta,
  type PublicTest,
} from '../../api/tests';
import { formatDate } from '../../components/catalog/format';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Chip } from '../../components/ui/Chip';
import { Dialog } from '../../components/ui/Dialog';
import { METHOD_LABEL, PRIMARY_LINK } from '../../lib/format';

const FILTER_CONTROL = 'rounded-xl border border-line-strong bg-night-0/60 px-3 py-2 text-sm text-white';

function TestRow({ test, onDelete, onRestore }: { test: PublicTest; onDelete(): void; onRestore(): void }) {
  return (
    <li>
      <Card className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${test.archivedAt ? 'opacity-70' : ''}`}>
        <div className="min-w-0 flex-1 basis-64">
          <Link to={`/admin/tests/${test.id}`} className="font-display text-base font-bold text-white no-underline hover:underline">
            {test.name}
          </Link>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Chip>{test.category}</Chip>
            {test.tags.map((t) => (
              <Chip key={t} className="text-mute">
                {t}
              </Chip>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-0.5 text-xs text-mute">
          <span>Notation : {METHOD_LABEL[test.scoringMethod]}</span>
          <span>
            {test.usedInRuns > 0 ? `Utilisé dans ${test.usedInRuns} ${test.usedInRuns > 1 ? 'séries' : 'série'}` : 'Jamais utilisé'}
            {test.attachments.length > 0 ? ` · ${test.attachments.length} ${test.attachments.length > 1 ? 'pièces jointes' : 'pièce jointe'}` : ''}
          </span>
          <span>Modifié le {formatDate(test.updatedAt)}</span>
        </div>
        <div className="flex items-center gap-2">
          {test.archivedAt ? (
            <>
              <Chip tone="live">Archivé</Chip>
              <Button variant="secondary" aria-label={`Restaurer ${test.name}`} onClick={onRestore}>
                Restaurer
              </Button>
            </>
          ) : (
            <Button variant="ghost" aria-label={`Supprimer ${test.name}`} onClick={onDelete}>
              Supprimer
            </Button>
          )}
        </div>
      </Card>
    </li>
  );
}

/** Tests (Admin) : liste filtrable, suppression (archivage si le test est utilisé) et restauration. */
export function TestsPage() {
  const client = useQueryClient();
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [toDelete, setToDelete] = useState<PublicTest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filters = { archived, category: category || undefined, tag: tag || undefined, q: q || undefined };
  const tests = useQuery({ queryKey: [...TESTS_KEY, 'list', filters], queryFn: () => listTests(filters), placeholderData: keepPreviousData });
  const meta = useQuery({ queryKey: TESTS_META_KEY, queryFn: testsMeta });

  const refresh = () => client.invalidateQueries({ queryKey: TESTS_KEY });
  const remove = useMutation({
    mutationFn: (t: PublicTest) => deleteTest(t.id),
    onSuccess: (outcome) => {
      setNotice(outcome === 'archived' ? 'Test archivé (utilisé par une série)' : 'Test supprimé');
      void refresh();
    },
    onError: (err) => setError(messageForError(err)),
    onSettled: () => setToDelete(null),
  });
  const restore = useMutation({
    mutationFn: (t: PublicTest) => restoreTest(t.id),
    onSuccess: () => {
      setNotice('Test restauré');
      void refresh();
    },
    onError: (err) => setError(messageForError(err)),
  });

  return (
    <div className="mx-auto max-w-[1100px]">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">Tests</h1>
          <p className="mt-2 mb-0 max-w-prose text-sm text-mute">
            Un test réunit un prompt, d’éventuelles pièces jointes et une méthode de notation. Un test déjà utilisé par une série est archivé au lieu d’être supprimé.
          </p>
        </div>
        <Link to="/admin/tests/nouveau" className={PRIMARY_LINK}>
          Nouveau test
        </Link>
      </header>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink">
          Catégorie
          <select className={FILTER_CONTROL} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Toutes</option>
            {meta.data?.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink">
          Tag
          <select className={FILTER_CONTROL} value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Tous</option>
            {meta.data?.tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1.5 text-[13px] font-medium text-ink">
          Recherche
          <input type="search" className={FILTER_CONTROL} value={q} placeholder="Nom ou prompt" onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 pb-2.5 text-[13px] text-ink">
          <input type="checkbox" className="h-4 w-4 accent-orange" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Afficher les archivés
        </label>
      </div>

      <div aria-live="polite" className="mb-3 min-h-5 text-sm">
        {notice ? <span className="text-good">{notice}</span> : null}
        {error ? (
          <span role="alert" className="text-bad">
            {error}
          </span>
        ) : null}
      </div>

      {tests.isError ? (
        <p role="alert" className="text-sm text-bad">
          {messageForError(tests.error)}
        </p>
      ) : tests.isPending ? (
        <p className="text-sm text-mute">Chargement des tests…</p>
      ) : tests.data.length === 0 ? (
        <p className="text-sm text-mute">
          {archived || category || tag || q ? 'Aucun test ne correspond à ces filtres.' : 'Aucun test pour l’instant. Créez le premier avec « Nouveau test ».'}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {tests.data.map((t) => (
            <TestRow
              key={t.id}
              test={t}
              onDelete={() => {
                setNotice(null);
                setError(null);
                setToDelete(t);
              }}
              onRestore={() => {
                setNotice(null);
                setError(null);
                restore.mutate(t);
              }}
            />
          ))}
        </ul>
      )}

      <Dialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Supprimer ce test ?"
        description={
          toDelete && toDelete.usedInRuns > 0
            ? `« ${toDelete.name} » est utilisé par une série : il sera archivé et restera consultable dans les résultats.`
            : toDelete
              ? `« ${toDelete.name} » et ses pièces jointes seront supprimés définitivement.`
              : undefined
        }
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setToDelete(null)}>
            Annuler
          </Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => toDelete && remove.mutate(toDelete)}>
            Confirmer la suppression
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
