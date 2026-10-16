import type { Db } from '../../db/client.js';
import type { AppConfig } from '../../config/config.js';
import type { Clock } from '../../lib/clock.js';
import { createErrorAlertHandler, createErrorDigestHandler } from '../errors/notifications.js';
import { createErrorsPurgeHandler } from '../errors/report.js';
import type { Mailer } from '../mail/mailer.js';
import type { JobHandlers } from './queue.js';

type LogFn = (obj: object, msg: string) => void;

export type JobHandlersDeps = {
  db: Db;
  mailer: Mailer;
  config: Pick<AppConfig, 'appBaseUrl'>;
  clock: Clock;
  logger: { info: LogFn; warn: LogFn; error: LogFn };
};

/** Registre des gestionnaires de tâches, construit au démarrage (les plans suivants y ajoutent leurs types). */
export function createJobHandlers(deps: JobHandlersDeps): JobHandlers {
  return {
    errors_purge: createErrorsPurgeHandler(),
    error_alert: createErrorAlertHandler(deps),
    error_digest: createErrorDigestHandler(deps),
  };
}
