import type { Db } from '../../db/client.js';
import type { AppConfig } from '../../config/config.js';
import type { Clock } from '../../lib/clock.js';
import { createCatalogRefreshHandler } from '../catalog/openrouter-sync.js';
import { createErrorAlertHandler, createErrorDigestHandler } from '../errors/notifications.js';
import { createErrorsPurgeHandler } from '../errors/report.js';
import type { Mailer } from '../mail/mailer.js';
import type { Registry } from '../providers/registry.js';
import { executeRunSlice } from '../runs/engine.js';
import { createOnResultFinished } from '../scoring/on-result.js';
import { RUN_EXECUTE } from '../runs/run-job.js';
import { QUICK_TRY, createQuickTryHandler } from '../tests/quick-try.js';
import type { JobHandlers } from './queue.js';

type LogFn = (obj: object, msg: string) => void;

export type JobHandlersDeps = {
  db: Db;
  mailer: Mailer;
  config: Pick<AppConfig, 'appBaseUrl' | 'dataDir'>;
  /** Adaptateurs des fournisseurs (exécution des séries). */
  registry: Registry;
  clock: Clock;
  logger: { info: LogFn; warn: LogFn; error: LogFn };
  /** `fetch` des tâches qui appellent un service externe (le `fetch` global par défaut ; injecté par les tests). */
  fetch?: typeof fetch;
};

/** Registre des gestionnaires de tâches, construit au démarrage (les plans suivants y ajoutent leurs types). */
export function createJobHandlers(deps: JobHandlersDeps): JobHandlers {
  return {
    errors_purge: createErrorsPurgeHandler(),
    error_alert: createErrorAlertHandler(deps),
    error_digest: createErrorDigestHandler(deps),
    catalog_refresh: createCatalogRefreshHandler({ ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
    [QUICK_TRY]: createQuickTryHandler({ db: deps.db, registry: deps.registry, config: deps.config }),
    [RUN_EXECUTE]: (job, ctx) =>
      executeRunSlice(
        { db: deps.db, registry: deps.registry, config: deps.config, onResultFinished: createOnResultFinished({ db: deps.db }) },
        job,
        ctx,
      ),
  };
}
