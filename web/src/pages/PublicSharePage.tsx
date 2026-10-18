import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { getPublicShare, type PublicShare } from '../api/public-share';
import { messageForError } from '../api/messages';
import { Card } from '../components/ui/Card';
import { CategoryHeatmap } from '../components/results/CategoryHeatmap';
import { Constellation } from '../components/results/Constellation';
import { Podium } from '../components/results/Podium';
import { QualitySpeedChart } from '../components/results/QualitySpeedChart';
import { RankingTable } from '../components/results/RankingTable';
import { PublicResponses } from '../components/sharing/PublicResponses';
import { StaticPodium } from '../components/sharing/StaticPodium';
import { VerdictCards } from '../components/sharing/VerdictCards';
import type { RankedRow } from '../lib/ranking';
import { FanoutFallback } from '../three/FanoutFallback';
import { createFanoutScene } from '../three/fanout-scene';
import { ThreeStage } from '../three/ThreeStage';

/** Nombre de modèles tracés dans le nuage qualité et vitesse (les mieux classés) ; la matrice par catégorie les montre tous. */
const CHART_MODELS = 6;

/** Date de fin de la série, en toutes lettres (ex. « 15 octobre 2026 »). */
const testDate = (iso: string | null): string | null =>
  iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : null;

/** Même animation que la page de connexion ; le bandeau étant moins haut, ses textes sont agrandis pour rester lisibles. */
const shareScene = createFanoutScene({ textScale: 2.2 });

function Brand() {
  return (
    <div className="flex items-center gap-3 text-white">
      <img src="/logo-icon-white.png" alt="" className="logo-glow block h-9 w-auto" />
      <span className="font-mono text-[19px] leading-tight font-semibold">
        Eksplodo
        <small className="block font-mono text-[10px] font-semibold tracking-[0.08em] text-mute">COMPARATEUR IA</small>
      </span>
    </div>
  );
}

/** Garde côté client : seul un lien `https://` est injecté dans un `href` (jamais `javascript:` ou autre schéma). */
const isHttps = (url: string): boolean => url.startsWith('https://');

function AuditButton({ url }: { url: string }) {
  if (!isHttps(url)) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center justify-center whitespace-nowrap rounded-full bg-gradient-to-r from-orange to-orange-soft px-5 py-2.5 text-[13px] font-semibold text-white no-underline shadow-[0_8px_24px_-8px_rgba(240,99,31,0.7)] hover:brightness-110 no-print"
    >
      Audit gratuit
    </a>
  );
}

/** Cadre commun (en-tête, bouton) des états chargement, erreur et page complète. */
function Frame({ children, auditUrl, printable = false }: { children: ReactNode; auditUrl?: string; printable?: boolean }) {
  return (
    <div className="share-page min-h-screen overflow-x-hidden">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-4 sm:px-8">
        <Brand />
        <div className="no-print flex items-center gap-2">
          {printable ? (
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-full border border-line-strong bg-night-2/70 px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-night-2"
            >
              Version imprimable
            </button>
          ) : null}
          {auditUrl ? <AuditButton url={auditUrl} /> : null}
        </div>
      </header>
      {children}
    </div>
  );
}

function Notice({ title, text }: { title: string; text?: string }) {
  return (
    <main className="mx-auto flex max-w-xl flex-col items-center gap-3 px-4 py-24 text-center">
      <h1 className="m-0 font-display text-3xl font-extrabold text-white">{title}</h1>
      {text ? <p className="m-0 text-sm text-mute">{text}</p> : null}
    </main>
  );
}

function ShareContent({ share }: { share: PublicShare }) {
  // Rang et score global viennent du serveur : avec les coûts masqués, un recalcul donnerait un autre score.
  const rows: RankedRow[] = useMemo(() => share.models.map((model) => ({ model, rank: model.rank, global: model.global })), [share.models]);
  const chartModels = useMemo(() => share.models.slice(0, CHART_MODELS), [share.models]);
  const { run } = share;
  const date = testDate(run.completedAt);
  const plural = run.modelCount > 1 ? 's' : '';
  const facts = [
    `${run.modelCount} modèle${plural} testé${plural} sur ${run.testCount} cas, ${run.repetitions} répétition${run.repetitions > 1 ? 's' : ''}`,
    run.judgeName ? `notés par un juge IA (${run.judgeName})` : null,
    share.showCosts && run.totalCostUsd !== null ? `coût total de la série : ${run.totalCostUsd.toLocaleString('fr-FR', { maximumFractionDigits: 4 })} $` : null,
  ].filter((f): f is string => f !== null);

  return (
    <Frame auditUrl={share.auditUrl} printable>
      <section className="relative border-b border-line lg:flex lg:min-h-[480px] lg:items-center">
        {/* Sur petit écran, la gerbe passerait sous le titre et gênerait la lecture : réservée aux grands écrans. Sur grand
            écran, elle occupe une bande qui commence juste après le milieu (près du titre, qui passe à la ligne avant),
            plus étroite que 1024 px : la scène s'y centre, à l'écart du texte. */}
        <div data-testid="share-gerbe" className="no-print absolute inset-y-0 left-[calc(50%_+_60px)] hidden w-[min(40%,760px)] lg:block">
          <ThreeStage factory={shareScene} fallback={<FanoutFallback className="h-full w-full" />} />
        </div>
        <div className="relative z-10 mx-auto w-full max-w-[1100px] px-4 py-14 sm:px-8 sm:py-20">
          {/* Sur grand écran, le texte s'arrête avant la bande de la gerbe (milieu + 60 px, moins le retrait du conteneur
              centré et une marge) : un titre long passe à la ligne au lieu de passer sous l'animation. */}
          <div data-testid="share-intro" className="max-w-[40rem] lg:max-w-[min(40rem,calc(50vw_+_60px_-_max(0px,(100vw_-_1100px)/2)_-_56px))]">
            {run.completedAt === null ? (
              <span className="mr-2 inline-block rounded-full border border-line-strong bg-night-2/70 px-3 py-1 font-mono text-[11px] font-semibold text-sky">Résultats provisoires</span>
            ) : null}
            {date ? (
              <span className="inline-block rounded-full border border-orange/50 bg-orange/10 px-3 py-1 font-mono text-[11px] font-semibold text-peach">Date du test : {date}</span>
            ) : null}
            <h1 className="mt-3.5 mb-0 font-display text-3xl leading-[1.1] font-extrabold tracking-[-0.01em] [overflow-wrap:anywhere] text-white sm:text-5xl">{share.title}</h1>
            {share.intro ? <p className="mt-4 mb-0 text-[15px] leading-relaxed whitespace-pre-line text-[#b9d4e1]">{share.intro}</p> : null}
            {/* Une information par ligne : nombre de modèles et de cas, juge, coût. */}
            <ul aria-label="Informations sur la série" className="mt-4 mb-0 flex list-none flex-col gap-1 p-0 font-mono text-xs text-mute">
              {facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <main className="mx-auto flex max-w-[1100px] flex-col gap-5 px-4 py-6 pb-16 sm:px-8">
        <VerdictCards verdicts={share.verdicts} />
        {/* Comme dans l'application : constellation et podium côte à côte, à la même hauteur. La constellation n'est
            pas imprimée (version imprimable) : le podium reprend alors toute la largeur. */}
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr] print:block">
          <Constellation models={share.models} className="no-print" />
          <Card className="flex flex-col gap-4">
            <h2 className="m-0 font-display text-base font-bold text-white">
              Podium <span className="ml-1 font-mono text-[11px] font-medium text-mute">score global pondéré</span>
            </h2>
            <div className="no-print">
              <Podium rows={rows} />
            </div>
            <StaticPodium rows={rows} />
          </Card>
        </div>
        {/* Nuage puis matrice, chacun sur toute la largeur : la matrice a besoin de place pour ses colonnes. */}
        <Card className="min-w-0">
          <h2 className="m-0 mb-2 font-display text-sm font-bold text-white">
            Qualité et vitesse <span className="ml-1 font-mono text-[11px] font-medium text-mute">en haut à droite : idéal</span>
          </h2>
          {rows.length > CHART_MODELS ? (
            <p className="m-0 mb-2 text-xs text-mute">
              {CHART_MODELS} premiers modèles sur {rows.length} ; la matrice par catégorie les montre tous.
            </p>
          ) : null}
          <QualitySpeedChart models={chartModels} />
        </Card>
        <Card className="min-w-0">
          <h2 className="m-0 mb-2 font-display text-sm font-bold text-white">
            Qualité par catégorie de test <span className="ml-1 font-mono text-[11px] font-medium text-mute">note moyenne sur 100</span>
          </h2>
          <CategoryHeatmap models={share.models} categories={share.categories} />
        </Card>
        <RankingTable rows={rows} judgeName={run.judgeName} hideCosts={!share.showCosts} />
        {share.responses ? <PublicResponses responses={share.responses} models={share.models} /> : null}
        {isHttps(share.auditUrl) ? (
          <div className="no-print flex flex-col items-center gap-3 pt-6 text-center">
            <p className="m-0 max-w-md text-sm text-ink">Quel modèle pour vos propres usages ? Nous faisons passer ce banc d'essai à vos cas réels.</p>
            <AuditButton url={share.auditUrl} />
          </div>
        ) : null}
      </main>
    </Frame>
  );
}

/** Page publique d'un lien de partage : lecture seule, sans session ni menu, une seule requête `GET /share/:token`. */
export default function PublicSharePage() {
  const { token = '' } = useParams();
  const { data, error, isPending } = useQuery({
    queryKey: ['public-share', token],
    queryFn: () => getPublicShare(token),
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Page à ne pas indexer : le lien est privé.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
  useEffect(() => {
    if (!data) return;
    const previous = document.title;
    document.title = `${data.title} · Eksplodo`;
    return () => {
      document.title = previous;
    };
  }, [data]);

  if (isPending) {
    return (
      <Frame>
        <main role="status" className="py-24 text-center text-sm text-mute">
          Chargement des résultats…
        </main>
      </Frame>
    );
  }
  if (error) {
    const status = error instanceof ApiError ? error.status : 0;
    return (
      <Frame>
        {status === 404 ? (
          <Notice title="Ce lien n'existe pas ou a été désactivé" text="Demandez à la personne qui vous l'a transmis un lien à jour." />
        ) : status === 429 ? (
          <Notice title="Trop de consultations, réessayez dans une minute" />
        ) : (
          <Notice title="Les résultats sont indisponibles" text={messageForError(error)} />
        )}
      </Frame>
    );
  }
  return <ShareContent share={data} />;
}
