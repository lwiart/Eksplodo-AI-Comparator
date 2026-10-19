import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { messageForScoreError } from '../api/messages';
import { TODO_KEY, attachmentUrl, attachmentViewUrl, getQuestion, questionKey, saveQuestionScores, type BlindQuestion } from '../api/scoring';
import { Markdown } from '../components/results/Markdown';
import { ScoreInput } from '../components/scoring/ScoreInput';
import { AttachmentGallery } from '../components/ui/AttachmentGallery';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { Breadcrumb } from '../components/ui/Breadcrumb';

/** Notation à l'aveugle d'une question : réponses A, B, C… puis, après enregistrement, révélation des modèles. */
export function BlindScoringPage() {
  const { runTestId = '' } = useParams();
  const question = useQuery({ queryKey: questionKey(runTestId), queryFn: () => getQuestion(runTestId) });
  // Erreur du dernier enregistrement, gardée ici : si la question relue a changé, le formulaire repart de zéro sans la perdre.
  const [saveError, setSaveError] = useState<unknown>(null);

  return (
    <div className="mx-auto max-w-[1200px]">
      <Breadcrumb
        items={[{ label: 'À noter', to: '/a-noter' }, ...(question.data ? [{ label: question.data.runName }, { label: question.data.testName }] : [{ label: 'Notation à l’aveugle' }])]}
      />
      {question.isError ? (
        <p role="alert" className="mt-4 text-sm text-bad">
          {messageForScoreError(question.error)}
        </p>
      ) : question.isPending ? (
        <p className="mt-4 text-sm text-mute">Chargement de la question…</p>
      ) : (
        <QuestionForm key={answersSignature(runTestId, question.data)} question={question.data} saveError={saveError} onSaveError={setSaveError} />
      )}
    </div>
  );
}

/** Clé du formulaire : il repart de zéro quand les réponses de la question relue ne sont plus les mêmes (lettres recalculées). */
function answersSignature(runTestId: string, question: BlindQuestion): string {
  return [runTestId, ...question.answers.map((a) => `${a.letter}:${a.responseText.length}`)].join('|');
}

function QuestionForm({
  question,
  saveError,
  onSaveError,
}: {
  question: BlindQuestion;
  saveError: unknown;
  onSaveError: (err: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const [scores, setScores] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(question.answers.map((a) => [a.letter, a.myScore])),
  );
  const [comments, setComments] = useState<Record<string, string>>(() =>
    Object.fromEntries(question.answers.map((a) => [a.letter, a.myComment ?? ''])),
  );

  const save = useMutation({
    mutationFn: () =>
      saveQuestionScores(
        question.runTestId,
        question.answers.map((a) => {
          const comment = (comments[a.letter] ?? '').trim();
          return { letter: a.letter, score: scores[a.letter] as number, ...(comment ? { comment } : {}) };
        }),
      ),
    onSuccess: (saved) => {
      onSaveError(null);
      queryClient.setQueryData(questionKey(question.runTestId), saved);
      void queryClient.invalidateQueries({ queryKey: TODO_KEY });
    },
    // Refus (réponse arrivée entre-temps, question pas encore prête…) : la question est relue pour montrer son état réel.
    onError: (err) => {
      onSaveError(err);
      void queryClient.invalidateQueries({ queryKey: questionKey(question.runTestId) });
      void queryClient.invalidateQueries({ queryKey: TODO_KEY });
    },
  });

  const allScored = question.answers.length > 0 && question.answers.every((a) => scores[a.letter] != null);
  const reveal = new Map((question.reveal ?? []).map((r) => [r.letter, r]));
  const revealed = question.complete && reveal.size > 0;
  const scored = question.answers.filter((a) => scores[a.letter] != null).length;

  return (
    <>
      <header className="mb-4">
        <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">
          Notation à l’aveugle
        </h1>
        <p className="mt-2 mb-0 max-w-prose text-sm text-mute">
          {revealed
            ? 'Vos notes sont enregistrées : voici les modèles derrière chaque réponse.'
            : 'Les modèles sont masqués et l’ordre est propre à votre compte. Les noms apparaissent une fois vos notes enregistrées.'}
        </p>
      </header>

      <Card className="mb-4">
        <div className="flex items-center gap-3">
          <Chip tone="live">
            {scored} / {question.answers.length} notées
          </Chip>
          <div
            role="progressbar"
            aria-label="Avancement de la notation"
            aria-valuemin={0}
            aria-valuemax={question.answers.length}
            aria-valuenow={scored}
            className="h-1.5 flex-1 rounded-full bg-white/10"
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-orange to-peach transition-[width]"
              style={{ width: `${(scored / Math.max(1, question.answers.length)) * 100}%` }}
            />
          </div>
        </div>
        {question.systemPrompt ? (
          <p className="mt-3 mb-0 text-[13px] text-mute">
            <b className="text-ink">Consigne système :</b> {question.systemPrompt}
          </p>
        ) : null}
        <p className="mt-3 mb-0 text-[15px] whitespace-pre-wrap text-white">
          <b>Prompt :</b> {question.userPrompt}
        </p>
        {question.attachments.length > 0 ? (
          <div className="mt-3">
            {/* Pièces jointes du test : seul leur nom de fichier apparaît, jamais un nom de modèle. */}
            <AttachmentGallery
              items={question.attachments.map((att) => ({
                name: att.originalName,
                mime: att.mime,
                viewUrl: attachmentViewUrl(question.runTestId, att.index),
                downloadUrl: attachmentUrl(question.runTestId, att.index),
              }))}
            />
          </div>
        ) : null}
      </Card>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
        {question.answers.map((a) => {
          const model = reveal.get(a.letter);
          return (
            <article
              key={a.letter}
              aria-label={`Réponse ${a.letter}`}
              className="flex flex-col rounded-2xl border border-line bg-[rgba(0,19,29,0.45)] p-3.5 text-[13px] leading-[1.55] text-ink"
            >
              <div className="mb-2.5 flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-xl bg-gradient-to-br from-blue to-[#06405d] font-display text-[26px] font-extrabold text-white"
                >
                  {a.letter}
                </span>
                {model && revealed ? (
                  <span className="reveal-in inline-flex items-center gap-2 rounded-full border border-line-strong px-3 py-1 font-semibold text-white">
                    <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: model.color }} />
                    {model.modelName}
                  </span>
                ) : null}
              </div>
              <div className="min-h-24 flex-1">
                <Markdown text={a.responseText} />
              </div>
              <ScoreInput label={`réponse ${a.letter}`} value={scores[a.letter] ?? null} onChange={(n) => setScores((s) => ({ ...s, [a.letter]: n }))} />
              <textarea
                aria-label={`Commentaire sur la réponse ${a.letter}`}
                placeholder="Commentaire (facultatif)"
                maxLength={2000}
                rows={2}
                value={comments[a.letter] ?? ''}
                onChange={(e) => setComments((c) => ({ ...c, [a.letter]: e.target.value }))}
                className="mt-2 w-full resize-y rounded-lg border border-line bg-night-2/50 px-3 py-2 text-[13px] text-ink placeholder:text-mute"
              />
            </article>
          );
        })}
      </div>

      {saveError != null ? (
        <p role="alert" className="mt-3 mb-0 text-sm text-bad">
          {messageForScoreError(saveError)}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Link
          to="/a-noter"
          className="inline-flex items-center rounded-full px-4 py-2 text-[13px] font-semibold text-ink no-underline hover:bg-blue/10"
        >
          {revealed ? 'Retour à la liste' : 'Passer'}
        </Link>
        <Button variant="primary" disabled={!allScored || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Enregistrement…' : revealed ? 'Mettre à jour mes notes' : 'Enregistrer et révéler'}
        </Button>
      </div>
    </>
  );
}
