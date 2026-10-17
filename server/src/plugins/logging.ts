import type { FastifyRequest } from 'fastify';

export type LogStream = { write(line: string): void };

// Paramètre dont le nom contient « token » (token, resetToken…) : sa valeur est un jeton actif.
const TOKEN_PARAM = /([?&](?:[^=&#]*token[^=&#]*)=)[^&#]*/gi;
// Liens à jeton (e-mail, partage) : le jeton est le segment de chemin qui suit /invitation/, /reinitialiser/, /share/ ou /p/.
const TOKEN_PATH = /(\/(?:invitation|reinitialiser|share|p)\/)[^/?#]+/gi;

/** Masque les jetons de l'URL : segment de chemin des liens d'invitation, de réinitialisation et de partage (`[REDACTED]`) et paramètres de type jeton (`[redacted]`). */
export function redactUrl(url: string): string {
  const path = url.replace(TOKEN_PATH, '$1[REDACTED]');
  return path.includes('?') ? path.replace(TOKEN_PARAM, '$1[redacted]') : path;
}

/** Sérialiseur `req` des journaux Fastify : comme celui par défaut, mais sans jeton dans l'URL (liens d'invitation…). */
export function serializeRequest(req: FastifyRequest): Record<string, unknown> {
  return {
    method: req.method,
    url: redactUrl(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/** Options du journal Fastify : désactivé en test sauf flux explicite (tests du journal). */
export function loggerOptions(nodeEnv: string, stream?: LogStream) {
  if (nodeEnv === 'test' && !stream) return false;
  return { level: 'info', serializers: { req: serializeRequest }, ...(stream ? { stream } : {}) };
}
