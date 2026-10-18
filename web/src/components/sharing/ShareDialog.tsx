import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { messageForError } from '../../api/messages';
import { getRanking, rankingKey } from '../../api/results';
import { RUNS_KEY, getRunResults } from '../../api/runs';
import { SHARE_LINKS_KEY, createShareLink, shareUrl, updateShareLink, type ShareLink } from '../../api/sharing';
import { Button } from '../ui/Button';
import { CopyLink } from '../ui/CopyLink';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/Field';
import { TextArea } from '../ui/TextArea';
import type { ShareVerdict } from '../../api/sharing';
import { COST_VERDICT_LABEL, MAX_VERDICTS, fromDraft, newKey, proposeVerdicts, toDraft, VerdictsEditor, type DraftVerdict } from './VerdictsEditor';

type Props = {
  runId: string;
  /** Nom de la série : titre proposé à la création. */
  runName: string;
  open: boolean;
  onClose(): void;
  /** Lien à modifier ; absent, le dialogue crée un lien. */
  link?: ShareLink;
};

/** Création (ou modification) d'un lien de partage ; le lien complet n'est montré qu'une fois, juste après la création. */
export function ShareDialog({ runId, runName, open, onClose, link }: Props) {
  const client = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const ranking = useQuery({ queryKey: rankingKey(runId), queryFn: () => getRanking(runId), enabled: open });
  // Mêmes résultats que la page de la série (cache partagé) : sert à repérer les questions manuelles.
  const results = useQuery({ queryKey: [...RUNS_KEY, runId, 'results'], queryFn: () => getRunResults(runId), enabled: open });
  const hasManual = results.data?.some((r) => r.scoreStatus === 'awaiting_manual' || r.hiddenUntilScored) ?? false;
  const [busy, setBusy] = useState(false);

  // Le jeton ne survit pas à sa fenêtre.
  const close = () => {
    setToken(null);
    onClose();
  };

  const title = token ? 'Lien de partage créé' : link ? 'Modifier le lien' : 'Partager la série';
  return (
    <Dialog
      open={open}
      // Tant que le jeton est affiché (une seule fois) ou qu'un envoi est en cours, seul « Fermer » ferme la fenêtre.
      onOpenChange={(o) => !o && token === null && !busy && close()}
      size="wide"
      title={title}
      description={token ? undefined : 'Une page publique en lecture seule, sans connexion ni accès au reste de l’application.'}
    >
      {token ? (
        <div className="flex flex-col gap-3">
          <CopyLink url={shareUrl(token)} label="Lien de la page publique" />
          <p className="m-0 text-sm text-mute">Vous pourrez le retrouver à tout moment dans Admin → Liens de partage (« Copier le lien »).</p>
          <p className="m-0 text-xs text-mute">Si vous le perdez, régénérez-le depuis « Liens de partage » : l’ancien cessera de fonctionner.</p>
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>
              Fermer
            </Button>
          </div>
        </div>
      ) : ranking.isError ? (
        <p role="alert" className="m-0 text-sm text-bad">
          {messageForError(ranking.error)}
        </p>
      ) : !ranking.data ? (
        <p className="m-0 text-sm text-mute">Chargement du classement…</p>
      ) : (
        <ShareForm
          runId={runId}
          runName={runName}
          link={link}
          models={ranking.data.models}
          initialVerdicts={link ? link.verdicts.map(toDraft) : proposeVerdicts(ranking.data, false).map(toDraft)}
          costVerdict={proposeVerdicts(ranking.data, true).find((v) => v.label === COST_VERDICT_LABEL) ?? null}
          hasManual={hasManual}
          onBusyChange={setBusy}
          onCancel={close}
          onDone={(issued) => {
            void client.invalidateQueries({ queryKey: SHARE_LINKS_KEY });
            if (issued) setToken(issued);
            else close();
          }}
        />
      )}
    </Dialog>
  );
}

function ShareForm({
  runId,
  runName,
  link,
  models,
  initialVerdicts,
  costVerdict,
  hasManual,
  onBusyChange,
  onCancel,
  onDone,
}: {
  runId: string;
  runName: string;
  link?: ShareLink;
  models: { modelId: string; name: string }[];
  initialVerdicts: DraftVerdict[];
  /** Verdict « Le moins cher » proposé quand on active l'affichage des coûts (absent sans aucun coût). */
  costVerdict: ShareVerdict | null;
  /** La série contient des questions manuelles (notation à l'aveugle en cours ou à faire). */
  hasManual: boolean;
  onBusyChange(busy: boolean): void;
  onCancel(): void;
  /** Jeton en clair après une création ; `null` après une modification. */
  onDone(token: string | null): void;
}) {
  const [title, setTitle] = useState(link?.title ?? runName);
  const [intro, setIntro] = useState(link?.intro ?? '');
  const [verdicts, setVerdicts] = useState(initialVerdicts);
  const [showCosts, setShowCosts] = useState(link?.showCosts ?? false);
  const [showResponses, setShowResponses] = useState(link?.showResponses ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setBusyBoth = (b: boolean) => {
    setBusy(b);
    onBusyChange(b);
  };
  // Proposé une seule fois, à la première activation des coûts sur un nouveau lien.
  const [costOffered, setCostOffered] = useState(false);
  const changeShowCosts = (checked: boolean) => {
    setShowCosts(checked);
    if (checked && !link && !costOffered && costVerdict && verdicts.length < MAX_VERDICTS && !verdicts.some((v) => v.label === COST_VERDICT_LABEL)) {
      setVerdicts([...verdicts, { ...costVerdict, key: newKey() }]);
      setCostOffered(true);
    }
  };
  const revealsCosts = !showCosts && verdicts.some((v) => /moins cher/i.test(v.label));

  const invalid = title.trim() === '' || verdicts.some((v) => v.label.trim() === '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusyBoth(true);
    const fields = {
      title: title.trim(),
      intro: intro.trim() === '' ? null : intro.trim(),
      verdicts: verdicts.map(fromDraft),
      showCosts,
      showResponses,
    };
    try {
      if (link) {
        await updateShareLink(link.id, { ...fields, active: link.active });
        onDone(null);
      } else {
        onDone((await createShareLink({ runId, ...fields })).token);
      }
    } catch (err) {
      setError(messageForError(err));
    } finally {
      setBusyBoth(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
      <Field label="Titre de la page" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
      <TextArea
        label="Introduction"
        rows={3}
        maxLength={2000}
        hint="Facultative : quelques lignes affichées sous le titre."
        value={intro}
        onChange={(e) => setIntro(e.target.value)}
      />
      <VerdictsEditor verdicts={verdicts} models={models} onChange={setVerdicts} />
      <fieldset className="m-0 flex flex-col gap-2 rounded-xl border border-line p-3">
        <legend className="px-1 text-[13px] font-medium text-ink">Ce que voit le public</legend>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={showCosts} onChange={(e) => changeShowCosts(e.target.checked)} />
          Afficher les coûts
        </label>
        {revealsCosts ? (
          <p role="note" className="m-0 ml-6 text-xs text-peach">
            Le verdict « Le moins cher » révèle l’ordre des coûts, même masqués : retirez-le si vous voulez les garder confidentiels.
          </p>
        ) : null}
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={showResponses} onChange={(e) => setShowResponses(e.target.checked)} />
          Afficher les réponses
        </label>
        {hasManual ? (
          <p role="note" className="m-0 ml-6 text-xs text-peach">
            Cette série contient des questions manuelles : la page publique associe chaque réponse à son modèle, ce qui lève l’aveugle pour qui n’a pas encore noté.
          </p>
        ) : null}
      </fieldset>
      {error ? (
        <p role="alert" className="m-0 text-sm text-bad">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Annuler
        </Button>
        <Button type="submit" variant="primary" disabled={busy || invalid}>
          {link ? 'Enregistrer' : 'Créer le lien'}
        </Button>
      </div>
    </form>
  );
}
