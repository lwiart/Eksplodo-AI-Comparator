import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { messageForError } from '../api/messages';
import { TODO_KEY, getTodo, type TodoItem } from '../api/scoring';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';
import { plural } from '../lib/format';

/** Questions manuelles que le compte n'a pas encore notées en entier, regroupées par série. */
export function ToScorePage() {
  const todo = useQuery({ queryKey: TODO_KEY, queryFn: getTodo, refetchInterval: 60_000 });
  const items = (todo.data ?? []).filter((i) => i.scoredByMe < i.answers);

  const groups = new Map<string, { runName: string; items: TodoItem[] }>();
  for (const item of items) {
    const group = groups.get(item.runId) ?? { runName: item.runName, items: [] };
    group.items.push(item);
    groups.set(item.runId, group);
  }

  return (
    <div className="mx-auto max-w-[900px]">
      <header className="mb-5">
        <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">À noter</h1>
        <p className="mt-2 mb-0 max-w-prose text-sm text-mute">
          Notez chaque réponse de 0 à 100 sans savoir quel modèle l’a écrite. Les noms apparaissent une fois vos notes enregistrées.
        </p>
      </header>

      {todo.isError ? (
        <p role="alert" className="text-sm text-bad">
          {messageForError(todo.error)}
        </p>
      ) : todo.isPending ? (
        <p className="text-sm text-mute">Chargement des questions…</p>
      ) : items.length === 0 ? (
        <Card className="py-10 text-center">
          <p className="m-0 text-sm text-mute">
            Rien à noter pour l’instant. Les nouvelles questions apparaîtront ici dès qu’une série aura des réponses à évaluer.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {[...groups.entries()].map(([runId, group]) => (
            <section key={runId} aria-label={group.runName}>
              <h2 className="mx-1 mt-0 mb-2 text-sm font-semibold text-white">
                <Link to={`/series/${runId}`} className="text-white no-underline hover:underline">
                  {group.runName}
                </Link>
              </h2>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {group.items.map((i) => (
                  <li key={i.runTestId}>
                    <Link
                      to={`/a-noter/${i.runTestId}`}
                      className="card-surface flex items-center gap-3 px-4 py-3 text-ink no-underline hover:border-line-strong"
                    >
                      <span className="min-w-0 flex-1 truncate font-semibold text-white">{i.testName}</span>
                      <span className="text-xs text-mute">{plural(i.answers, 'réponse', 'réponses')}</span>
                      <Chip tone={i.scoredByMe > 0 ? 'live' : 'default'}>
                        {i.scoredByMe} / {i.answers} notées
                      </Chip>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
