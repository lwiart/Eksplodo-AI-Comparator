import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { messageForError } from '../../api/messages';
import {
  SUITES_KEY,
  TESTS_KEY,
  createSuite,
  deleteSuite,
  duplicateSuite,
  listSuites,
  listTests,
  updateSuite,
  type PublicSuite,
  type PublicSuiteTest,
  type PublicTest,
} from '../../api/tests';
import { Breadcrumb } from '../../components/ui/Breadcrumb';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Chip } from '../../components/ui/Chip';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { TextArea } from '../../components/ui/TextArea';
import { METHOD_LABEL } from '../../lib/format';

/** Brouillon en cours d'édition : `id` absent = nouvelle suite. */
type Draft = { id: string | null; name: string; description: string; tests: PublicSuiteTest[] };

function toSuiteTest(t: PublicTest): PublicSuiteTest {
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    scoringMethod: t.scoringMethod,
    archived: t.archivedAt !== null,
    attachmentCount: t.attachments.length,
  };
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

function summary(suite: PublicSuite): string {
  const n = suite.tests.length;
  if (n === 0) return 'Aucun test';
  const archived = suite.tests.filter((t) => t.archived).length;
  const base = `${n} ${n > 1 ? 'tests' : 'test'}`;
  return archived > 0 ? `${base} dont ${archived} ${archived > 1 ? 'archivés' : 'archivé'}` : base;
}

const ICON_BUTTON = 'px-3 py-1.5';

function SuiteEditor({
  draft,
  onChange,
  onCancel,
  onSave,
  saving,
  error,
}: {
  draft: Draft;
  onChange(next: Draft): void;
  onCancel(): void;
  onSave(): void;
  saving: boolean;
  error: string | null;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const available = useQuery({ queryKey: [...TESTS_KEY, 'list', 'suite-picker'], queryFn: () => listTests() });
  const chosen = new Set(draft.tests.map((t) => t.id));
  const candidates = (available.data ?? []).filter((t) => t.archivedAt === null && !chosen.has(t.id));
  const setTests = (tests: PublicSuiteTest[]) => onChange({ ...draft, tests });

  return (
    <Card className="mb-6 flex flex-col gap-4" aria-label={draft.id ? 'Modifier la suite' : 'Nouvelle suite'}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
      >
        <Field label="Nom" value={draft.name} maxLength={200} required onChange={(e) => onChange({ ...draft, name: e.target.value })} />
        <TextArea
          label="Description"
          rows={2}
          value={draft.description}
          maxLength={5000}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />

        <div className="grid gap-5 md:grid-cols-[1.3fr_1fr]">
          <section aria-label="Tests de la suite">
            <h2 className="m-0 mb-2 font-display text-base font-bold text-white">Tests de la suite, dans l’ordre d’exécution</h2>
            {draft.tests.length === 0 ? (
              <p className="m-0 text-sm text-mute">Aucun test pour l’instant. Ajoutez-en depuis la liste.</p>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-2 p-0">
                {draft.tests.map((t, i) => (
                  <li
                    key={t.id}
                    data-testid="suite-test"
                    data-test-id={t.id}
                    draggable
                    onDragStart={(e) => {
                      setDragIndex(i);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', t.id);
                    }}
                    onDragOver={(e) => {
                      if (dragIndex === null) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragIndex !== null) setTests(move(draft.tests, dragIndex, i));
                      setDragIndex(null);
                    }}
                    onDragEnd={() => setDragIndex(null)}
                    className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line-strong bg-night-0/60 px-3 py-2 ${
                      dragIndex === i ? 'opacity-40' : ''
                    } ${t.archived ? 'border-dashed' : ''}`}
                  >
                    <span aria-hidden="true" className="cursor-grab select-none text-mute" title="Glisser pour réordonner">
                      ⠿
                    </span>
                    <span className="w-6 text-right font-mono text-xs text-mute">{i + 1}</span>
                    <div className="min-w-0 flex-1 basis-40">
                      <div className="truncate text-sm font-semibold text-white">{t.name}</div>
                      <div className="text-xs text-mute">
                        {t.category} · {METHOD_LABEL[t.scoringMethod]}
                      </div>
                    </div>
                    {t.archived ? <Chip tone="live">Archivé</Chip> : null}
                    <div className="flex items-center gap-1.5">
                      <Button variant="ghost" className={ICON_BUTTON} aria-label={`Monter ${t.name}`} disabled={i === 0} onClick={() => setTests(move(draft.tests, i, i - 1))}>
                        ↑
                      </Button>
                      <Button
                        variant="ghost"
                        className={ICON_BUTTON}
                        aria-label={`Descendre ${t.name}`}
                        disabled={i === draft.tests.length - 1}
                        onClick={() => setTests(move(draft.tests, i, i + 1))}
                      >
                        ↓
                      </Button>
                      <Button variant="ghost" className={ICON_BUTTON} aria-label={`Retirer ${t.name}`} onClick={() => setTests(draft.tests.filter((x) => x.id !== t.id))}>
                        Retirer
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section aria-label="Tests disponibles">
            <h2 className="m-0 mb-2 font-display text-base font-bold text-white">Tests disponibles</h2>
            {available.isError ? (
              <p role="alert" className="m-0 text-sm text-bad">
                {messageForError(available.error)}
              </p>
            ) : available.isPending ? (
              <p className="m-0 text-sm text-mute">Chargement des tests…</p>
            ) : candidates.length === 0 ? (
              <p className="m-0 text-sm text-mute">Tous les tests actifs sont déjà dans la suite.</p>
            ) : (
              <ul className="m-0 flex max-h-96 list-none flex-col gap-2 overflow-y-auto p-0">
                {candidates.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-white">{t.name}</div>
                      <div className="text-xs text-mute">{t.category}</div>
                    </div>
                    <Button variant="secondary" className={ICON_BUTTON} aria-label={`Ajouter ${t.name}`} onClick={() => setTests([...draft.tests, toSuiteTest(t)])}>
                      Ajouter
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {error ? (
          <p role="alert" className="m-0 text-sm text-bad">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Annuler
          </Button>
          <Button variant="primary" type="submit" disabled={saving || draft.name.trim() === ''}>
            Enregistrer
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Suites (Admin) : création, choix et ordre des tests (glisser-déposer ou boutons), duplication, suppression. */
export function SuitesPage() {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toDelete, setToDelete] = useState<PublicSuite | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const suites = useQuery({ queryKey: SUITES_KEY, queryFn: listSuites });
  const refresh = () => client.invalidateQueries({ queryKey: SUITES_KEY });
  const reset = () => {
    setNotice(null);
    setError(null);
  };

  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body = { name: d.name.trim(), description: d.description.trim() === '' ? null : d.description, testIds: d.tests.map((t) => t.id) };
      return d.id ? updateSuite(d.id, body) : createSuite(body);
    },
    onSuccess: () => {
      setNotice('Suite enregistrée');
      setDraft(null);
      void refresh();
    },
    onError: (err) => setSaveError(messageForError(err)),
  });
  const duplicate = useMutation({
    mutationFn: (s: PublicSuite) => duplicateSuite(s.id),
    onSuccess: () => {
      setNotice('Suite dupliquée');
      void refresh();
    },
    onError: (err) => setError(messageForError(err)),
  });
  const remove = useMutation({
    mutationFn: (s: PublicSuite) => deleteSuite(s.id),
    onSuccess: () => {
      setNotice('Suite supprimée');
      void refresh();
    },
    onError: (err) => setError(messageForError(err)),
    onSettled: () => setToDelete(null),
  });

  const open = (next: Draft) => {
    reset();
    setSaveError(null);
    setDraft(next);
  };

  // Édition : seule la suite éditée s'affiche ; la liste des suites reste sur l'accueil des suites.
  if (draft) {
    const title = draft.id === null ? 'Nouvelle suite' : draft.name.trim() || 'Suite sans nom';
    return (
      <div className="mx-auto max-w-[1100px]">
        {/* L'éditeur s'ouvre sur la page des suites : « Suites » le referme et ramène à la liste. */}
        <Breadcrumb items={[{ label: 'Suites', onClick: () => setDraft(null) }, { label: title }]} />
        <header className="mb-5">
          <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] [overflow-wrap:anywhere] text-white">{title}</h1>
        </header>
        <SuiteEditor
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => save.mutate(draft)}
          saving={save.isPending}
          error={saveError}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1100px]">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">Suites</h1>
          <p className="mt-2 mb-0 max-w-prose text-sm text-mute">
            Une suite est une liste ordonnée de tests à lancer ensemble sur plusieurs modèles. Les tests archivés restent visibles mais ne peuvent plus être ajoutés.
          </p>
        </div>
        <Button variant="primary" onClick={() => open({ id: null, name: '', description: '', tests: [] })}>
          Nouvelle suite
        </Button>
      </header>

      <div aria-live="polite" className="mb-3 min-h-5 text-sm">
        {notice ? <span className="text-good">{notice}</span> : null}
        {error ? (
          <span role="alert" className="text-bad">
            {error}
          </span>
        ) : null}
      </div>

      {suites.isError ? (
        <p role="alert" className="text-sm text-bad">
          {messageForError(suites.error)}
        </p>
      ) : suites.isPending ? (
        <p className="text-sm text-mute">Chargement des suites…</p>
      ) : suites.data.length === 0 ? (
        <p className="text-sm text-mute">Aucune suite pour l’instant. Créez la première avec « Nouvelle suite ».</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {suites.data.map((s) => (
            <li key={s.id}>
              <Card className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="font-display text-base font-bold text-white">{s.name}</div>
                  <div className="mt-1 text-xs text-mute">{summary(s)}</div>
                  {s.description ? <p className="mt-1.5 mb-0 text-sm text-ink">{s.description}</p> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    aria-label={`Modifier ${s.name}`}
                    onClick={() => open({ id: s.id, name: s.name, description: s.description ?? '', tests: s.tests })}
                  >
                    Modifier
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Dupliquer ${s.name}`}
                    disabled={duplicate.isPending}
                    onClick={() => {
                      reset();
                      duplicate.mutate(s);
                    }}
                  >
                    Dupliquer
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Supprimer ${s.name}`}
                    onClick={() => {
                      reset();
                      setToDelete(s);
                    }}
                  >
                    Supprimer
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Supprimer cette suite ?"
        description={toDelete ? `« ${toDelete.name} » sera supprimée. Les tests qu’elle contient ne sont pas touchés.` : undefined}
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
