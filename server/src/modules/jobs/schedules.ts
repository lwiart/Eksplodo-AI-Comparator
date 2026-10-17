import type { ScheduleEntry } from './scheduler.js';
import { validateScheduleEntry } from './scheduler.js';

/**
 * Planification du processus : purge quotidienne du journal des erreurs (03:30, heure de Paris), récapitulatif des
 * erreurs (07:30) et synchronisation du catalogue OpenRouter (06:00). Les plans suivants y ajoutent leurs entrées. Les horaires sont validés au démarrage.
 */
export function appSchedules(): ScheduleEntry[] {
  return [
    { key: 'errors-purge', times: ['03:30'], build: () => [{ type: 'errors_purge' }] },
    { key: 'error-digest', times: ['07:30'], build: () => [{ type: 'error_digest' }] },
    { key: 'catalog-refresh', times: ['06:00'], build: () => [{ type: 'catalog_refresh' }] },
  ].map(validateScheduleEntry);
}
