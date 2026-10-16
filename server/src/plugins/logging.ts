import type { FastifyRequest } from 'fastify';

export type LogStream = { write(line: string): void };

// Paramètre dont le nom contient « token » (token, resetToken…) : sa valeur est un jeton actif.
// Et paramètre `q` : une recherche de documents peut citer des extraits de DCE.
const TOKEN_PARAM = /([?&](?:[^=&#]*token[^=&#]*|q)=)[^&#]*/gi;

/** Remplace la valeur des paramètres de type jeton (et `q`) de la chaîne de requête par `[redacted]`. */
export function redactUrl(url: string): string {
  return url.includes('?') ? url.replace(TOKEN_PARAM, '$1[redacted]') : url;
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
