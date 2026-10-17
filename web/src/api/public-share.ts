import { apiFetch } from './client';
import type { RankingModel } from './results';
import type { Weights } from './runs';

// Types miroirs de server/src/modules/sharing/public-share.ts.
/** Modèle de la page publique : clé opaque (`m1`, `m2`…), rang et score global calculés par le serveur. */
export type PublicModel = RankingModel & { rank: number | null; global: number | null };

export type PublicVerdict = { label: string; text: string; model: { key: string; name: string; color: string } | null };

export type PublicAnswer = { modelKey: string; repetition: number; text: string | null; finalScore: number | null; judgeRationale: string | null };

export type PublicResponse = { testName: string; category: string; userPrompt: string; answers: PublicAnswer[] };

export type PublicShare = {
  title: string;
  intro: string | null;
  auditUrl: string;
  showCosts: boolean;
  run: {
    name: string;
    completedAt: string | null;
    modelCount: number;
    testCount: number;
    repetitions: number;
    judgeName: string | null;
    totalCostUsd: number | null;
  };
  weights: Weights;
  categories: string[];
  models: PublicModel[];
  verdicts: PublicVerdict[];
  responses: PublicResponse[] | null;
};

/** Seule requête de la page publique : `GET /share/:token` (hors `/api`, sans session). */
export function getPublicShare(token: string): Promise<PublicShare> {
  return apiFetch(`/share/${encodeURIComponent(token)}`);
}
