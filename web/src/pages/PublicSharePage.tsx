import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { getPublicShare, type PublicShare } from '../api/public-share';
import { messageForError } from '../api/messages';
import { Card } from '../components/ui/Card';
import { CategoryChart } from '../components/results/CategoryChart';
import { Podium } from '../components/results/Podium';
import { QualitySpeedChart } from '../components/results/QualitySpeedChart';
import { RankingTable } from '../components/results/RankingTable';
import { PublicResponses } from '../components/sharing/PublicResponses';
import { StaticPodium } from '../components/sharing/StaticPodium';
import { VerdictCards } from '../components/sharing/VerdictCards';
import type { RankedRow } from '../lib/ranking';
import { FanoutFallback } from '../three/FanoutFallback';
import { fanoutScene } from '../three/fanout-scene';
import { ThreeStage } from '../three/ThreeStage';

/** Nombre de modèles tracés dans les graphes (les mieux classés). */
const CHART_MODELS = 6;

const monthYear = (iso: string | null): string | null =>
  iso ? new Date(iso).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }) : null;

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
  const date = monthYear(run.completedAt);
  const plural = run.modelCount > 1 ? 's' : '';
  const facts = [
    `${run.modelCount} modèle${plural} testé${plural} sur ${run.testCount} cas`,
    run.judgeName ? `notés par un juge IA (${run.judgeName})` : null,
    share.showCosts && run.totalCostUsd !== null ? `coût total de la série : ${run.totalCostUsd.toLocaleString('fr-FR', { maximumFractionDigits: 4 })} $` : null,
  ].filter((f): f is string => f !== null);

  return (
    <Frame auditUrl={share.auditUrl} printable>
      <section className="relative border-b border-line">
        {/* Sur petit écran, la gerbe passerait sous le titre et gênerait la lecture : réservée aux grands écrans. */}
        <div className="no-print hidden lg:block">
          <ThreeStage factory={fanoutScene} fallback={<FanoutFallback className="h-full w-full lg:translate-x-[18%]" />} />
        </div>
        <div className="relative z-10 mx-auto max-w-[1100px] px-4 py-14 sm:px-8 sm:py-20">
          <div className="max-w-[40rem]">
            {run.completedAt === null ? (
              <span className="mr-2 inline-block rounded-full border border-line-strong bg-night-2/70 px-3 py-1 font-mono text-[11px] font-semibold text-sky">Résultats provisoires</span>
            ) : null}
            {date ? (
              <span className="inline-block rounded-full border border-orange/50 bg-orange/10 px-3 py-1 font-mono text-[11px] font-semibold text-peach">Résultats de {date}</span>
            ) : null}
            <h1 className="mt-3.5 mb-0 font-display text-3xl leading-[1.1] font-extrabold tracking-[-0.01em] text-white sm:text-5xl">{share.title}</h1>
            {share.intro ? <p className="mt-4 mb-0 text-[15px] leading-relaxed whitespace-pre-line text-[#b9d4e1]">{share.intro}</p> : null}
            <p className="mt-4 mb-0 font-mono text-xs text-mute">{facts.join(' · ')}</p>
          </div>
        </div>
      </section>

      <main className="mx-auto flex max-w-[1100px] flex-col gap-5 px-4 py-6 pb-16 sm:px-8">
        <VerdictCards verdicts={share.verdicts} />
        <Card className="flex flex-col gap-4">
          <h2 className="m-0 font-display text-base font-bold text-white">
            Podium <span className="ml-1 font-mono text-[11px] font-medium text-mute">score global pondéré</span>
          </h2>
          <div className="no-print">
            <Podium rows={rows} />
          </div>
          <StaticPodium rows={rows} />
        </Card>
        {rows.length > CHART_MODELS ? (
          <p className="m-0 text-xs text-mute">
            Graphes : {CHART_MODELS} premiers modèles sur {rows.length}.
          </p>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="min-w-0">
            <h2 className="m-0 mb-2 font-display text-sm font-bold text-white">
              Qualité et vitesse <span className="ml-1 font-mono text-[11px] font-medium text-mute">en haut à droite : idéal</span>
            </h2>
            <QualitySpeedChart models={chartModels} />
          </Card>
          <Card className="min-w-0">
            <h2 className="m-0 mb-2 font-display text-sm font-bold text-white">
              Par catégorie <span className="ml-1 font-mono text-[11px] font-medium text-mute">qualité moyenne sur 100</span>
            </h2>
            <CategoryChart models={chartModels} categories={share.categories} />
          </Card>
        </div>
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
