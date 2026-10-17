import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { messageForError } from '../../api/messages';
import {
  TESTS_KEY,
  TESTS_META_KEY,
  createTest,
  getTest,
  testsMeta,
  updateTest,
  type PublicAttachment,
  type PublicTest,
  type TestInput,
} from '../../api/tests';
import { formatNumber } from '../../components/catalog/format';
import { AttachmentsField } from '../../components/tests/AttachmentsField';
import { QuickTryPanel } from '../../components/tests/QuickTryPanel';
import {
  EMPTY_SCORING,
  ScoringConfigForm,
  buildScoring,
  draftFromTest,
  type ScoringDraft,
  type ScoringErrors,
} from '../../components/tests/ScoringConfigForm';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Chip } from '../../components/ui/Chip';
import { Field } from '../../components/ui/Field';
import { TextArea } from '../../components/ui/TextArea';

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 1000;
const MAX_TOKENS_LIMIT = 16_000;

type Form = {
  name: string;
  category: string;
  tags: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: string;
  maxTokens: string;
  scoring: ScoringDraft;
};
type FormErrors = Partial<Record<'name' | 'category' | 'tags' | 'userPrompt' | 'systemPrompt' | 'temperature' | 'maxTokens', string>> & {
  scoring: ScoringErrors;
};

const EMPTY_FORM: Form = {
  name: '',
  category: '',
  tags: '',
  systemPrompt: '',
  userPrompt: '',
  temperature: formatNumber(DEFAULT_TEMPERATURE),
  maxTokens: formatNumber(DEFAULT_MAX_TOKENS),
  scoring: EMPTY_SCORING,
};

function formFromTest(t: PublicTest): Form {
  return {
    name: t.name,
    category: t.category,
    tags: t.tags.join(', '),
    systemPrompt: t.systemPrompt ?? '',
    userPrompt: t.userPrompt,
    temperature: formatNumber(t.temperature),
    maxTokens: formatNumber(t.maxTokens),
    scoring: draftFromTest(t.scoringMethod, t.scoringConfig),
  };
}

/** Nombre saisi à la française : virgule décimale, espaces (y compris insécables) entre les milliers. */
function parseNumber(text: string): number | null {
  const t = text.replace(/[\s  ]/g, '').replace(',', '.');
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

/** Corps à envoyer, ou les erreurs à afficher : mêmes bornes que le serveur, pour refuser avant tout envoi. */
function buildBody(f: Form): { ok: true; body: TestInput } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = { scoring: {} };
  const name = f.name.trim();
  const category = f.category.trim();
  const tags = f.tags.split(',').map((t) => t.trim()).filter((t) => t !== '');
  const temperature = parseNumber(f.temperature);
  const maxTokens = parseNumber(f.maxTokens);

  if (name === '') errors.name = 'Le nom est obligatoire.';
  else if (name.length > 200) errors.name = 'Le nom ne doit pas dépasser 200 caractères.';
  if (category === '') errors.category = 'La catégorie est obligatoire.';
  else if (category.length > 100) errors.category = 'La catégorie ne doit pas dépasser 100 caractères.';
  if (tags.length > 20) errors.tags = '20 tags au plus.';
  else if (tags.some((t) => t.length > 50)) errors.tags = 'Chaque tag fait 50 caractères au plus.';
  if (f.userPrompt.trim() === '') errors.userPrompt = 'Le prompt utilisateur est obligatoire.';
  else if (f.userPrompt.length > 100_000) errors.userPrompt = 'Le prompt ne doit pas dépasser 100 000 caractères.';
  if (f.systemPrompt.length > 50_000) errors.systemPrompt = 'Le prompt système ne doit pas dépasser 50 000 caractères.';
  if (temperature === null || temperature > 2) errors.temperature = 'La température doit être comprise entre 0 et 2.';
  if (maxTokens === null || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS_LIMIT) {
    errors.maxTokens = `Le maximum de tokens doit être un entier entre 1 et ${formatNumber(MAX_TOKENS_LIMIT)}.`;
  }
  const scoring = buildScoring(f.scoring);
  if (!scoring.ok) errors.scoring = scoring.errors;

  const { scoring: scoringErrors, ...own } = errors;
  if (Object.keys(own).length > 0 || Object.keys(scoringErrors).length > 0 || !scoring.ok) return { ok: false, errors };
  return {
    ok: true,
    body: {
      name,
      category,
      tags,
      systemPrompt: f.systemPrompt.trim() === '' ? null : f.systemPrompt,
      userPrompt: f.userPrompt,
      temperature: temperature!,
      maxTokens: maxTokens!,
      scoringMethod: f.scoring.method,
      scoringConfig: scoring.config,
    },
  };
}

function EditorForm({ initial }: { initial: PublicTest | null }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const meta = useQuery({ queryKey: TESTS_META_KEY, queryFn: testsMeta });

  const [form, setForm] = useState<Form>(initial ? formFromTest(initial) : EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({ scoring: {} });
  const [attachments, setAttachments] = useState<PublicAttachment[]>(initial?.attachments ?? []);
  const [testId, setTestId] = useState<string | null>(initial?.id ?? null);
  // Corps tel qu'enregistré : une saisie différente (ou invalide) est « non enregistrée ».
  const [savedKey, setSavedKey] = useState<string | null>(initial ? JSON.stringify(buildBodyOrNull(formFromTest(initial))) : null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const built = buildBody(form);
  const dirty = testId === null || !built.ok || JSON.stringify(built.body) !== savedKey;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: (body: TestInput) => (testId === null ? createTest(body) : updateTest(testId, body)),
  });

  /** Valide puis enregistre ; renvoie l'identifiant du test, ou `null` si la saisie ou le serveur refuse. */
  async function saveNow(): Promise<string | null> {
    setNotice(null);
    setError(null);
    const result = buildBody(form);
    if (!result.ok) {
      setErrors(result.errors);
      return null;
    }
    setErrors({ scoring: {} });
    if (!dirty && testId !== null) return testId;
    try {
      const saved = await save.mutateAsync(result.body);
      setSavedKey(JSON.stringify(result.body));
      void client.invalidateQueries({ queryKey: TESTS_KEY });
      if (testId === null) {
        navigate(`/admin/tests/${saved.id}`, { replace: true });
        return saved.id;
      }
      client.setQueryData([...TESTS_KEY, 'detail', saved.id], saved);
      setNotice('Test enregistré.');
      return saved.id;
    } catch (err) {
      setError(messageForError(err));
      return null;
    }
  }

  return (
    <div className="mx-auto max-w-[1100px]">
      <header className="mb-5">
        <Link to="/admin/tests" className="text-[13px] text-sky no-underline hover:underline">
          Tests
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">
            {initial ? initial.name : 'Nouveau test'}
          </h1>
          {initial?.archivedAt ? <Chip tone="live">Archivé</Chip> : null}
        </div>
        <p className="mt-2 mb-0 max-w-prose text-sm text-mute">Un test réunit un prompt, d’éventuelles pièces jointes et une méthode de notation.</p>
      </header>

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void saveNow();
        }}
        className="grid items-start gap-4 min-[1000px]:grid-cols-[1.25fr_1fr]"
      >
        <Card className="flex flex-col gap-4">
          <div className="grid gap-4 min-[600px]:grid-cols-[2fr_1fr]">
            <Field label="Nom" value={form.name} error={errors.name} maxLength={200} onChange={(e) => set('name', e.target.value)} />
            <Field
              label="Catégorie"
              list="test-categories"
              value={form.category}
              error={errors.category}
              maxLength={100}
              onChange={(e) => set('category', e.target.value)}
            />
            <datalist id="test-categories">
              {meta.data?.categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <TextArea
            label="Prompt système (facultatif)"
            rows={3}
            value={form.systemPrompt}
            error={errors.systemPrompt}
            onChange={(e) => set('systemPrompt', e.target.value)}
          />
          <TextArea
            label="Prompt utilisateur"
            rows={7}
            value={form.userPrompt}
            error={errors.userPrompt}
            onChange={(e) => set('userPrompt', e.target.value)}
          />
          <div className="grid gap-4 min-[600px]:grid-cols-3">
            <Field
              label="Température"
              inputMode="decimal"
              value={form.temperature}
              error={errors.temperature}
              hint="Entre 0 et 2."
              onChange={(e) => set('temperature', e.target.value)}
            />
            <Field
              label="Max tokens"
              inputMode="numeric"
              value={form.maxTokens}
              error={errors.maxTokens}
              hint="16 000 au plus."
              onChange={(e) => set('maxTokens', e.target.value)}
            />
            <Field label="Tags" value={form.tags} error={errors.tags} hint="Séparés par des virgules." onChange={(e) => set('tags', e.target.value)} />
          </div>
          {testId === null ? (
            <p className="m-0 rounded-[14px] border-[1.5px] border-dashed border-line-strong p-3.5 text-[13px] text-mute">
              Enregistrez le test pour joindre des fichiers.
            </p>
          ) : (
            <AttachmentsField
              testId={testId}
              attachments={attachments}
              onAdded={(a) => setAttachments((list) => [...list, a])}
              onRemoved={(id) => setAttachments((list) => list.filter((a) => a.id !== id))}
            />
          )}
        </Card>

        <Card className="flex flex-col gap-4">
          <h2 className="m-0 font-display text-lg font-bold text-white">Notation</h2>
          <ScoringConfigForm value={form.scoring} errors={errors.scoring} onChange={(s) => set('scoring', s)} />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <div aria-live="polite" className="min-w-0 flex-1 text-sm">
              {notice ? <span className="text-good">{notice}</span> : null}
              {error ? (
                <span role="alert" className="text-bad">
                  {error}
                </span>
              ) : null}
            </div>
            <Button type="submit" variant="primary" disabled={save.isPending}>
              Enregistrer
            </Button>
          </div>
        </Card>
      </form>

      <div className="mt-4">
        {testId === null ? (
          <Card>
            <h2 className="m-0 font-display text-lg font-bold text-white">Essai rapide</h2>
            <p className="mt-1 mb-0 text-sm text-mute">Enregistrez le test pour l’essayer sur un modèle.</p>
          </Card>
        ) : (
          <QuickTryPanel dirty={dirty} ensureSaved={saveNow} />
        )}
      </div>
    </div>
  );
}

function buildBodyOrNull(f: Form): TestInput | null {
  const r = buildBody(f);
  return r.ok ? r.body : null;
}

/** Éditeur d'un test (Admin) : prompts, paramètres, notation, pièces jointes et essai rapide. */
export function TestEditorPage() {
  const { id } = useParams<{ id: string }>();
  const test = useQuery({ queryKey: [...TESTS_KEY, 'detail', id], queryFn: () => getTest(id!), enabled: id !== undefined, staleTime: Infinity });

  if (id === undefined) return <EditorForm initial={null} />;
  if (test.isError) {
    return (
      <p role="alert" className="text-sm text-bad">
        {messageForError(test.error)}
      </p>
    );
  }
  if (test.isPending) return <p className="text-sm text-mute">Chargement du test…</p>;
  return <EditorForm key={test.data.id} initial={test.data} />;
}
