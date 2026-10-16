import type { Db } from '../../db/client.js';
import type { Clock } from '../../lib/clock.js';
import type { Mailer } from '../mail/mailer.js';
import { markReported, reportError } from './report.js';

/** Code de l'erreur d'envoi si c'est un identifiant simple (ex. ECONNREFUSED), sinon un code générique. */
export function sendFailureCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'send_failed';
}

/**
 * Décorateur du mailer réel : tout échec d'envoi est journalisé (source `mail`, origine `smtp`, grave, sans alerte pour
 * ne pas boucler), marqué comme déjà journalisé puis relancé tel quel : les appelants gardent leur comportement.
 * Le message est reconstruit : celui du serveur SMTP peut citer une adresse, un identifiant ou un hôte.
 * Un mailer qui n'envoie rien (`delivers === false`) est renvoyé tel quel : rien à journaliser.
 */
export function reportingMailer(mailer: Mailer, deps: { db: Db; clock: Clock }): Mailer {
  if (!mailer.delivers) return mailer;
  return {
    delivers: mailer.delivers,
    async send(msg) {
      try {
        await mailer.send(msg);
      } catch (err) {
        const code = sendFailureCode(err);
        const reference = await reportError(
          deps.db,
          { source: 'mail', origin: 'smtp', code, message: `Envoi d'e-mail impossible (${code})`, severity: 'grave', noAlert: true },
          deps.clock(),
        );
        markReported(err, reference);
        throw err;
      }
    },
  };
}
