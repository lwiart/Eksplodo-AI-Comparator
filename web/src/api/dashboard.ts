import { apiFetch } from './client';
import type { RunStatus } from './runs';

// Types miroirs de server/src/modules/dashboard/dashboard.service.ts.
export type Dashboard = {
  runs: { total: number; thisMonth: number };
  models: { tracked: number; providers: number };
  /** Nul pour un Utilisateur : la dépense est réservée à l'Admin. */
  spend: { monthUsd: number; judgeUsd: number } | null;
  toScore: { questions: number; runName: string | null };
  recentRuns: {
    id: string;
    name: string;
    suiteName: string | null;
    status: RunStatus;
    modelCount: number;
    winner: { name: string; color: string } | null;
    costUsd: number;
    completedAt: string | null;
    createdAt: string;
  }[];
  evolutionSuites: { id: string; name: string }[];
};

export type Evolution = {
  suite: { id: string; name: string };
  runs: { id: string; name: string; completedAt: string; judgeName: string | null }[];
  series: { modelId: string; name: string; color: string; points: (number | null)[] }[];
};

export const DASHBOARD_KEY = ['dashboard'] as const;
export const evolutionKey = (suiteId: string) => ['dashboard', 'evolution', suiteId] as const;

export function getDashboard(): Promise<Dashboard> {
  return apiFetch('/api/dashboard');
}

export function getEvolution(suiteId: string): Promise<Evolution> {
  return apiFetch(`/api/dashboard/evolution?suiteId=${encodeURIComponent(suiteId)}`);
}
