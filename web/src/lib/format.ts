// Mises en forme et libellés partagés par plusieurs pages.
import type { RunStatus, StatusCounts } from '../api/runs';
import type { ScoringMethod } from '../api/tests';
import { formatNumber } from '../components/catalog/format';

export const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export const usd = (n: number) =>
  `${n.toLocaleString('fr-FR', n > 0 && n < 0.01 ? { minimumFractionDigits: 4, maximumFractionDigits: 4 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

/** Montant d'un plafond, au dix-millième près (précision du plafond) : jamais arrondi en dessous de sa valeur. */
export const budgetUsd = (n: number) => `${n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} $`;

export function duration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Plafond saisi (virgule ou point) : `null` = sans plafond, `undefined` = saisie invalide. */
export function parseBudget(raw: string): number | null | undefined {
  const text = raw.trim().replace(',', '.');
  if (text === '') return null;
  const n = Number(text);
  const fourDecimals = Math.abs(n * 10_000 - Math.round(n * 10_000)) < 1e-6;
  return Number.isFinite(n) && n >= 0.0001 && n <= 999_999 && fourDecimals ? Math.round(n * 10_000) / 10_000 : undefined;
}

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'En file d’attente',
  running: 'En cours',
  paused: 'En pause',
  completed: 'Terminée',
  interrupted: 'Interrompue',
};

/** Appels terminés, quelle que soit l'issue (réussis, en erreur, hors délai, non supportés ou tronqués). */
export function finishedCalls(c: StatusCounts): number {
  return c.done + c.error + c.timeout + c.unsupported + c.truncated;
}

const LINK_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-[13px] font-semibold no-underline transition-[box-shadow] ';
/** Lien présenté comme le bouton principal. */
export const PRIMARY_LINK = `${LINK_BUTTON}bg-gradient-to-r from-orange to-orange-soft text-white shadow-[0_8px_24px_-8px_rgba(240,99,31,0.7)] hover:shadow-[0_8px_28px_-6px_rgba(240,99,31,0.85)]`;

export const METHOD_LABEL: Record<ScoringMethod, string> = {
  judge: 'IA-juge',
  expected: 'Réponse attendue',
  manual: 'Manuelle',
};

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${formatNumber(Math.round((bytes / (1024 * 1024)) * 10) / 10)} Mo`;
  return `${formatNumber(Math.max(1, Math.round(bytes / 1024)))} Ko`;
}
