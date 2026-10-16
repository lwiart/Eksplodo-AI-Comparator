import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { RateLimitedError } from '../errors.js';

type Warn = { warn(obj: object, msg: string): void };
type KeyRequest = Pick<FastifyRequest, 'headers'> & { ip?: string | undefined };

/** Configuration commune des routes d'authentification non authentifiées : 10 requêtes par IP et par 15 minutes. */
export const AUTH_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } } as const;

function lastHeaderValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const parts = (Array.isArray(value) ? value.join(',') : value)
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.at(-1) ?? null;
}

function normalize(ip: string): string {
  try {
    return rateLimit.normalizeIP(ip);
  } catch {
    return ip.toLowerCase();
  }
}

/**
 * Clé de limitation : `req.ip`, sinon (écoute sur un socket local, où `req.ip` est indéfini) la dernière valeur de
 * `x-real-ip` puis de `x-forwarded-for`, posées par le seul relais (LiteSpeed). `null` si aucune IP n'est connue.
 */
export function clientKeyOf(req: KeyRequest): string | null {
  if (typeof req.ip === 'string' && req.ip.length > 0) return normalize(req.ip);
  const fallback = lastHeaderValue(req.headers['x-real-ip']) ?? lastHeaderValue(req.headers['x-forwarded-for']);
  return fallback ? normalize(fallback) : null;
}

const NO_CLIENT_KEY = 'ip-inconnue';

/**
 * `keyGenerator` ne lève jamais (le générateur par défaut plante sur `req.ip` indéfini → 500). Sans IP connue, la
 * requête échappe à la limite par IP (`allowList`) ; le verrouillage par compte reste appliqué. Avertissement unique.
 */
export function createRateLimitKeying(log: Warn) {
  let warned = false;
  return {
    keyGenerator: (req: KeyRequest): string => clientKeyOf(req) ?? NO_CLIENT_KEY,
    allowList: (req: KeyRequest): boolean => {
      if (clientKeyOf(req) !== null) return false;
      if (!warned) {
        warned = true;
        log.warn(
          {},
          "adresse IP du client inconnue (ni req.ip, ni x-real-ip, ni x-forwarded-for) : limitation par IP désactivée pour ces requêtes",
        );
      }
      return true;
    },
  };
}

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  const keying = createRateLimitKeying(app.log);
  await app.register(rateLimit, {
    global: false,
    keyGenerator: keying.keyGenerator,
    allowList: keying.allowList,
    errorResponseBuilder: () => new RateLimitedError(),
  });
}
