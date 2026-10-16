import { Fragment, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ORIGIN_OPTIONS,
  REQUEST_ORIGIN_OPTION,
  findByReference,
  originLabel,
  useErrorAlertMode,
  useErrorList,
  useErrorSummary,
  useResolveErrors,
  useSaveErrorAlertMode,
  type ErrorAlertMode,
  type ErrorEvent,
  type ErrorFilters,
} from '../../api/errors';
import { ApiError } from '../../api/client';
import { messageForError } from '../../api/messages';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Chip } from '../../components/ui/Chip';
import { SelectField } from '../../components/ui/SelectField';

const HOUR_MS = 3_600_000;
const PERIODS = [
  { value: '24h', label: '24 dernières heures', ms: 24 * HOUR_MS },
  { value: '7d', label: '7 derniers jours', ms: 7 * 24 * HOUR_MS },
  { value: '30d', label: '30 derniers jours', ms: 30 * 24 * HOUR_MS },
  { value: '90d', label: '90 derniers jours', ms: 90 * 24 * HOUR_MS },
] as const;
type PeriodValue = (typeof PERIODS)[number]['value'];

const ALERT_CHOICES: { value: ErrorAlertMode; name: string; description: string }[] = [
  { value: 'none', name: 'Aucun e-mail', description: 'Vous consultez le journal des erreurs quand vous le souhaitez.' },
  {
    value: 'daily',
    name: 'Récapitulatif quotidien',
    description:
      "Un e-mail à 7 h 30, seulement s'il y a eu des erreurs depuis le récapitulatif précédent : nombre d'erreurs par gravité et par origine, les 10 plus fréquentes, lien vers le journal.",
  },
  {
    value: 'immediate',
    name: 'Immédiat pour les erreurs graves, plus le récapitulatif quotidien',
    description:
      "Un e-mail dès qu'une erreur grave survient (au plus un par type d'erreur et par heure ; les suivantes sont comptées dans l'e-mail suivant), plus le récapitulatif quotidien pour toutes les erreurs.",
  },
];

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });
const countFormat = new Intl.NumberFormat('fr-FR');
const formatDate = (iso: string) => dateFormat.format(new Date(iso));

const plural = (n: number, one: string, many: string) => `${countFormat.format(n)} ${n > 1 ? many : one}`;

const SMALL = 'px-3 py-1 text-xs';
const TH = 'px-3 py-3 font-medium';

function Alert({ error }: { error: unknown }) {
  return (
    <p role="alert" className="m-0 rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
      {messageForError(error)}
    </p>
  );
}

/** Journal des erreurs (Admin) : alertes par e-mail, synthèse, filtres, liste paginée et traitement des événements. */
export function ErrorLogPage() {
  const [period, setPeriod] = useState<PeriodValue>('7d');
  const [anchor, setAnchor] = useState(() => Date.now());
  const [severity, setSeverity] = useState<ErrorFilters['severity']>('');
  const [origin, setOrigin] = useState('');
  const [includeResolved, setIncludeResolved] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);

  const periodMs = PERIODS.find((p) => p.value === period)!.ms;
  const isRequest = origin === REQUEST_ORIGIN_OPTION;
  const filters: ErrorFilters = {
    from: new Date(anchor - periodMs).toISOString(),
    severity,
    origin: isRequest ? '' : origin,
    source: isRequest ? 'request' : '',
    includeResolved,
    page,
  };
  // Lien de l'e-mail d'alerte : ?ref=E-XXXXX ouvre directement l'événement.
  const [params] = useSearchParams();
  const initialRef = params.get('ref');
  const list = useErrorList(filters);
  const summary = useErrorSummary();
  const resolve = useResolveErrors();

  function change<T>(set: (v: T) => void) {
    return (value: T) => {
      set(value);
      setPage(1);
      setSelected([]);
    };
  }

  function goToPage(n: number) {
    setPage(n);
    setSelected([]);
  }

  function act(ids: string[], resolved: boolean) {
    resolve.mutate({ ids, resolved }, { onSuccess: () => setSelected([]) });
  }

  const items = list.data?.items ?? [];
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  // Dernière page vidée (événements traités ou rouverts) : retour à la dernière page existante.
  if (list.data && !list.isPlaceholderData && page > totalPages) setPage(totalPages);
  const allSelected = items.length > 0 && items.every((e) => selected.includes(e.id));

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-5">
      <header>
        <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">Journal des erreurs</h1>
        <p className="mt-2 mb-0 max-w-prose text-sm text-mute">
          Ce qui a échoué sur la plateforme, regroupé par type d&apos;erreur, avec la référence que les utilisateurs vous transmettent.
        </p>
      </header>

      <section aria-label="Synthèse" className="grid gap-3 min-[800px]:grid-cols-3">
        {summary.data ? (
          <>
            <SummaryCell title="Dernières 24 heures" data={summary.data.last24h} />
            <SummaryCell title="7 derniers jours" data={summary.data.last7d} />
            <Card>
              <h2 className="m-0 text-[13px] font-medium text-mute">Origines les plus fréquentes</h2>
              {summary.data.topOrigins.length === 0 ? (
                <p className="mt-2 mb-0 text-sm text-mute">Aucune sur 7 jours.</p>
              ) : (
                <ol className="m-0 mt-2 list-none p-0" aria-label="Origines les plus fréquentes sur 7 jours">
                  {summary.data.topOrigins.map((o) => (
                    <li key={o.origin} className="flex justify-between gap-3 py-0.5 text-sm text-ink">
                      <span>{originLabel(undefined, o.origin)}</span>
                      <span className="font-mono text-xs text-sky">{countFormat.format(o.count)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </>
        ) : summary.isError ? (
          <Alert error={summary.error} />
        ) : (
          <p className="m-0 text-sm text-mute">Chargement de la synthèse…</p>
        )}
      </section>
      <p className="m-0 -mt-2 text-xs text-mute">
        Un événement regroupe toutes les occurrences d&apos;une même erreur survenues à moins d&apos;une heure d&apos;écart.
      </p>

      <AlertSettings />

      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          label="Période"
          name="period"
          value={period}
          options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
          onChange={(e) => {
            change(setPeriod)(e.target.value as PeriodValue);
            setAnchor(Date.now());
          }}
        />
        <SelectField
          label="Gravité"
          name="severity"
          value={severity}
          options={[
            { value: '', label: 'Toutes' },
            { value: 'grave', label: 'Graves' },
            { value: 'normale', label: 'Normales' },
          ]}
          onChange={(e) => change(setSeverity)(e.target.value as ErrorFilters['severity'])}
        />
        <SelectField
          label="Origine"
          name="origin"
          value={origin}
          options={[{ value: '', label: 'Toutes' }, ...ORIGIN_OPTIONS]}
          onChange={(e) => change(setOrigin)(e.target.value)}
        />
        <label className="flex items-center gap-2 pb-2.5 text-[13px] text-ink">
          <input
            type="checkbox"
            className="h-4 w-4 accent-orange"
            checked={includeResolved}
            onChange={(e) => change(setIncludeResolved)(e.target.checked)}
          />
          Afficher les traitées
        </label>
      </div>

      <ReferenceSearch initial={initialRef} />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" className={SMALL} disabled={selected.length === 0 || resolve.isPending} onClick={() => act(selected, true)}>
          Marquer la sélection comme traitée
        </Button>
        <Button variant="ghost" className={SMALL} disabled={selected.length === 0 || resolve.isPending} onClick={() => act(selected, false)}>
          Rouvrir la sélection
        </Button>
        {selected.length > 0 ? (
          <span className="font-mono text-xs text-mute">{plural(selected.length, 'sélectionné', 'sélectionnés')}</span>
        ) : null}
      </div>
      {resolve.isError ? <Alert error={resolve.error} /> : null}

      {list.isError ? (
        <Alert error={list.error} />
      ) : list.isPending ? (
        <p className="m-0 text-sm text-mute">Chargement du journal…</p>
      ) : items.length === 0 ? (
        <Card>
          <p className="m-0 text-sm text-mute">Aucune erreur sur cette période avec ces filtres.</p>
        </Card>
      ) : (
        <>
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[900px] border-collapse text-left text-sm" aria-busy={list.isFetching}>
              <caption className="sr-only">Événements du journal des erreurs, du plus récent au plus ancien</caption>
              <thead>
                <tr className="border-b border-line text-[12px] text-mute">
                  <th scope="col" className={TH}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-orange"
                      aria-label="Tout sélectionner"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? [] : items.map((e) => e.id))}
                    />
                  </th>
                  <th scope="col" className={TH}>Dernière date</th>
                  <th scope="col" className={TH}>Gravité</th>
                  <th scope="col" className={TH}>Origine</th>
                  <th scope="col" className={TH}>Message</th>
                  <th scope="col" className={`${TH} text-right`}>Occurrences</th>
                  <th scope="col" className={TH}>Référence</th>
                  <th scope="col" className={TH}>Traitement</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <EventRows
                    key={e.id}
                    event={e}
                    selected={selected.includes(e.id)}
                    pending={resolve.isPending}
                    onSelect={(on) => setSelected((s) => (on ? [...s, e.id] : s.filter((id) => id !== e.id)))}
                    onResolve={(resolved) => act([e.id], resolved)}
                  />
                ))}
              </tbody>
            </table>
          </Card>
          {totalPages > 1 ? (
            <nav className="flex items-center justify-center gap-3" aria-label="Pagination">
              <Button variant="ghost" className={SMALL} disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                Page précédente
              </Button>
              <span className="font-mono text-xs text-mute">
                Page {page} sur {totalPages}
              </span>
              <Button variant="ghost" className={SMALL} disabled={page >= totalPages} onClick={() => goToPage(page + 1)}>
                Page suivante
              </Button>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}

function SummaryCell({ title, data }: { title: string; data: { total: number; grave: number } }) {
  return (
    <Card>
      <h2 className="m-0 text-[13px] font-medium text-mute">{title}</h2>
      <p className="mt-1.5 mb-0 font-display text-2xl font-extrabold text-white">{plural(data.total, 'événement', 'événements')}</p>
      <p className={`mt-0.5 mb-0 text-sm ${data.grave > 0 ? 'text-bad' : 'text-mute'}`}>dont {plural(data.grave, 'grave', 'graves')}</p>
    </Card>
  );
}

function AlertSettings() {
  const id = useId();
  const saved = useErrorAlertMode();
  const save = useSaveErrorAlertMode();
  const [choice, setChoice] = useState<ErrorAlertMode | null>(null);
  const current = choice ?? saved.data ?? null;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (current) save.mutate(current);
  }

  return (
    <Card>
      <form onSubmit={onSubmit} aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
        <fieldset className="m-0 border-0 p-0">
          <legend id={`${id}-title`} className="p-0 font-display text-base font-bold text-white">
            Alertes par e-mail
          </legend>
          <p className="mt-1 mb-3 text-sm text-mute">Les administrateurs actifs reçoivent ces e-mails.</p>
          <div className="flex flex-col gap-2">
            {ALERT_CHOICES.map((o) => (
              <label
                key={o.value}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 ${
                  current === o.value ? 'border-orange/60 bg-orange/10' : 'border-line bg-night-0/30'
                }`}
              >
                <input
                  type="radio"
                  className="mt-1 accent-orange"
                  name={`${id}-mode`}
                  value={o.value}
                  checked={current === o.value}
                  disabled={current === null}
                  aria-labelledby={`${id}-${o.value}`}
                  aria-describedby={`${id}-${o.value}-desc`}
                  onChange={() => {
                    setChoice(o.value);
                    save.reset();
                  }}
                />
                <span className="flex flex-col gap-0.5">
                  <span id={`${id}-${o.value}`} className="text-sm font-semibold text-white">
                    {o.name}
                  </span>
                  <span id={`${id}-${o.value}-desc`} className="text-xs leading-relaxed text-mute">
                    {o.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {saved.isError ? <Alert error={saved.error} /> : null}
        {save.isError ? <Alert error={save.error} /> : null}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={current === null || current === saved.data || save.isPending} aria-busy={save.isPending}>
            Enregistrer
          </Button>
          {save.isSuccess ? (
            <p role="status" className="m-0 text-sm text-good">
              Réglage enregistré.
            </p>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

function ReferenceSearch({ initial }: { initial: string | null }) {
  const id = useId();
  const [value, setValue] = useState(initial ?? '');
  const [state, setState] = useState<
    { status: 'idle' } | { status: 'busy' } | { status: 'none' } | { status: 'found'; item: ErrorEvent } | { status: 'error'; error: unknown }
  >({ status: 'idle' });

  async function lookup(reference: string) {
    if (reference.trim() === '') return;
    setState({ status: 'busy' });
    try {
      const { item } = await findByReference(reference);
      setState({ status: 'found', item });
    } catch (err) {
      setState(err instanceof ApiError && err.status === 404 ? { status: 'none' } : { status: 'error', error: err });
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void lookup(value);
  }

  useEffect(() => {
    if (initial) void lookup(initial);
    // Une seule fois, à l'ouverture de la page avec ?ref=.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <form className="flex flex-wrap items-end gap-2" onSubmit={onSubmit}>
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium text-ink" htmlFor={`${id}-ref`}>
            Référence
          </label>
          <input
            id={`${id}-ref`}
            className="rounded-xl border border-line-strong bg-night-0/60 px-3 py-2.5 font-mono text-sm text-white placeholder:text-mute/70"
            value={value}
            autoComplete="off"
            spellCheck={false}
            placeholder="E-XXXXX"
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={state.status === 'busy'}>
          Ouvrir
        </Button>
      </form>
      {state.status === 'none' ? (
        <p role="status" className="m-0 text-sm text-mute">
          Aucune erreur avec cette référence.
        </p>
      ) : null}
      {state.status === 'error' ? <Alert error={state.error} /> : null}
      {state.status === 'found' ? (
        <Card role="region" aria-label="Événement trouvé">
          <p className="m-0 mb-3 flex flex-wrap items-center gap-2 text-sm text-ink">
            <SeverityChip severity={state.item.severity} />
            <span>{originLabel(state.item.source, state.item.origin)}</span>
            <span className="font-mono text-xs text-sky">{state.item.reference}</span>
          </p>
          <EventDetail event={state.item} />
        </Card>
      ) : null}
    </div>
  );
}

function SeverityChip({ severity }: { severity: ErrorEvent['severity'] }) {
  return severity === 'grave' ? <Chip tone="bad">Grave</Chip> : <Chip>Normale</Chip>;
}

type RowProps = {
  event: ErrorEvent;
  selected: boolean;
  pending: boolean;
  onSelect: (on: boolean) => void;
  onResolve: (resolved: boolean) => void;
};

function EventRows({ event: e, selected, pending, onSelect, onResolve }: RowProps) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const resolved = e.resolvedAt !== null;
  return (
    <Fragment>
      <tr className={`border-b border-line align-top ${resolved ? 'opacity-60' : ''}`}>
        <td className="px-3 py-3">
          <input
            type="checkbox"
            className="h-4 w-4 accent-orange"
            aria-label={`Sélectionner ${e.reference}`}
            checked={selected}
            onChange={(ev) => onSelect(ev.target.checked)}
          />
        </td>
        <td className="px-3 py-3 font-mono text-xs whitespace-nowrap text-mute">{formatDate(e.lastSeenAt)}</td>
        <td className="px-3 py-3">
          <SeverityChip severity={e.severity} />
        </td>
        <td className="px-3 py-3 text-ink">{originLabel(e.source, e.origin)}</td>
        <td className="max-w-[320px] px-3 py-3">
          <button
            type="button"
            className="flex w-full cursor-pointer items-start gap-2 border-0 bg-transparent p-0 text-left text-sm text-white"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={`Détail ${e.reference}`}
            onClick={() => setOpen((v) => !v)}
          >
            <span aria-hidden="true" className={`mt-0.5 text-xs text-sky transition-transform ${open ? 'rotate-90' : ''}`}>
              ▸
            </span>
            <span className="line-clamp-2 break-words">{e.message}</span>
          </button>
        </td>
        <td className="px-3 py-3 text-right font-mono text-xs text-ink">{countFormat.format(e.occurrences)}</td>
        <td className="px-3 py-3 font-mono text-xs whitespace-nowrap text-sky">{e.reference}</td>
        <td className="px-3 py-3">
          <Button variant="ghost" className={SMALL} disabled={pending} onClick={() => onResolve(!resolved)}>
            {resolved ? 'Rouvrir' : 'Marquer comme traitée'}
          </Button>
        </td>
      </tr>
      {open ? (
        <tr id={detailId} className="border-b border-line bg-night-0/40">
          <td colSpan={8} className="px-4 py-4">
            <EventDetail event={e} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-mute">{term}</dt>
      <dd className="m-0 font-mono text-xs text-ink">{children}</dd>
    </div>
  );
}

function EventDetail({ event: e }: { event: ErrorEvent }) {
  return (
    <div className="flex flex-col gap-3">
      <dl className="m-0 grid grid-cols-2 gap-3 min-[800px]:grid-cols-5">
        <Fact term="Code">{e.code}</Fact>
        <Fact term="Code HTTP">{e.httpStatus ?? '-'}</Fact>
        <Fact term="Première occurrence">{formatDate(e.firstSeenAt)}</Fact>
        <Fact term="Dernière occurrence">{formatDate(e.lastSeenAt)}</Fact>
        <Fact term="Utilisateur">{e.userName ?? '-'}</Fact>
      </dl>
      <div>
        <h3 className="m-0 mb-1 text-xs font-medium text-mute">Message complet</h3>
        <p className="m-0 text-sm break-words text-white">{e.message}</p>
      </div>
      {e.stack ? (
        <div>
          <h3 className="m-0 mb-1 text-xs font-medium text-mute">Pile d&apos;appels</h3>
          <pre
            tabIndex={0}
            className="m-0 max-h-64 overflow-auto rounded-xl border border-line bg-night-0/70 p-3 font-mono text-xs text-ink"
          >
            {e.stack}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
