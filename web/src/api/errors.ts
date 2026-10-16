import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

export type ErrorSeverity = 'grave' | 'normale';
export type ErrorSource = 'request' | 'job' | 'external' | 'mail';
export type ErrorAlertMode = 'none' | 'daily' | 'immediate';

export type ErrorEvent = {
  id: string;
  reference: string;
  severity: ErrorSeverity;
  source: ErrorSource;
  origin: string;
  code: string;
  httpStatus: number | null;
  message: string;
  stack: string | null;
  userId: string | null;
  userName: string | null;
  target: { type: string; id: string } | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  notifiedAt: string | null;
};

export type ErrorList = { items: ErrorEvent[]; total: number; page: number; pageSize: number };

/** Chiffres en événements (lignes regroupées), non en occurrences. */
export type ErrorSummary = {
  last24h: { total: number; grave: number };
  last7d: { total: number; grave: number };
  topOrigins: { origin: string; count: number }[];
  unresolvedGrave: number;
};

export type ErrorFilters = {
  from: string;
  severity: '' | ErrorSeverity;
  origin: string;
  /** « request » : page ou API (les routes ne sont pas énumérables, on filtre sur la source). */
  source: '' | 'request';
  includeResolved: boolean;
  page: number;
};

export const ERRORS_KEY = ['admin', 'errors'] as const;
export const ERRORS_SUMMARY_KEY = [...ERRORS_KEY, 'summary'] as const;
export const ERROR_ALERTS_KEY = ['admin', 'settings', 'notifications'] as const;

const ORIGIN_LABELS: Record<string, string> = {
  error_alert: 'Alerte d’erreur',
  error_digest: 'Récapitulatif des erreurs',
  errors_purge: 'Purge du journal',
  smtp: 'E-mail',
};

/** Valeur de l'option « Page / API » du filtre d'origine : elle envoie `source=request`, pas une origine. */
export const REQUEST_ORIGIN_OPTION = '@request';

/** Origines proposées au filtre (les routes des requêtes ne sont pas énumérables : une option « Page / API » les couvre). */
export const ORIGIN_OPTIONS = [
  { value: REQUEST_ORIGIN_OPTION, label: 'Page / API' },
  ...Object.entries(ORIGIN_LABELS).map(([value, label]) => ({ value, label })),
];

/** Origine en clair ; « Page / API » suivi de la route pour une requête ; une origine inconnue s'affiche telle quelle. */
export function originLabel(source: ErrorSource | undefined, origin: string): string {
  // Le résumé ne donne pas la source : une origine « METHODE /chemin » est une requête.
  if (source === 'request' || (source === undefined && /^[A-Z]+ \//.test(origin))) return `Page / API ${origin}`;
  return ORIGIN_LABELS[origin] ?? origin;
}

export function listPath(f: ErrorFilters): string {
  const p = new URLSearchParams();
  p.set('from', f.from);
  if (f.severity) p.set('severity', f.severity);
  if (f.source) p.set('source', f.source);
  if (f.origin) p.set('origin', f.origin);
  p.set('includeResolved', f.includeResolved ? '1' : '0');
  p.set('page', String(f.page));
  return `/api/admin/errors?${p.toString()}`;
}

export function useErrorList(filters: ErrorFilters) {
  return useQuery({
    queryKey: [...ERRORS_KEY, 'list', filters],
    queryFn: () => apiFetch<ErrorList>(listPath(filters)),
    placeholderData: (previous) => previous,
  });
}

/** Résumé et compteur du menu : chargé une fois, rafraîchi après une action de la page (pas de boucle). */
export function useErrorSummary(enabled = true) {
  return useQuery({
    queryKey: ERRORS_SUMMARY_KEY,
    queryFn: () => apiFetch<ErrorSummary>('/api/admin/errors/summary'),
    enabled,
    staleTime: 60_000,
  });
}

export function findByReference(reference: string): Promise<{ item: ErrorEvent }> {
  return apiFetch<{ item: ErrorEvent }>(`/api/admin/errors/by-reference/${encodeURIComponent(reference.trim())}`);
}

export function useResolveErrors() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (v: { ids: string[]; resolved: boolean }) =>
      apiFetch<{ updated: number }>('/api/admin/errors/resolve', { method: 'POST', body: v }),
    onSuccess: () => client.invalidateQueries({ queryKey: ERRORS_KEY }),
  });
}

export function useErrorAlertMode() {
  return useQuery({
    queryKey: ERROR_ALERTS_KEY,
    queryFn: async () => (await apiFetch<{ errorAlerts: ErrorAlertMode }>('/api/admin/settings/notifications')).errorAlerts,
  });
}

export function useSaveErrorAlertMode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (errorAlerts: ErrorAlertMode) =>
      apiFetch<{ errorAlerts: ErrorAlertMode }>('/api/admin/settings/notifications', { method: 'PUT', body: { errorAlerts } }),
    onSuccess: (data) => client.setQueryData(ERROR_ALERTS_KEY, data.errorAlerts),
  });
}
